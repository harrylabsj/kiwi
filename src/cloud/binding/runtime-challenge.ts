/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Runtime 侧挑战应答（设计 v0.1.2 §6.3 / §11.4 的 `/control/challenge`）。
 *
 * 约束（**绝不能变成"任意内容签名服务"**）：
 *   - 只接受结构完整的挑战（purpose/agent/merchant/generation/origin/path/指纹/
 *     nonce/有效期），且**挑战内指纹必须等于本实例公钥指纹**——发给别的实例的
 *     挑战一律拒绝（不让本实例替他方签名）；
 *   - 只签**挑战主体**（受限结构，成员固定），不签任何调用方提供的自由文本；
 *   - 一次性：同一 challenge_id 在本实例只应答一次（重放 → 409）；
 *   - 过期拒绝；代次不匹配拒绝；
 *   - 有速率上限：应答是受限动作，不接受刷量。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { JwsSigningIdentity } from "../../trust/identity/jws.js";
import {
  BindingChallengeStore,
  BindingProofError,
  challengeSubject,
  signBindingChallenge,
  type BindingChallenge,
} from "./proofs.js";
import { isThumbprint, publicKeyThumbprint } from "../../trust/binding/thumbprint.js";
import { createHash, createPublicKey } from "node:crypto";

export interface ChallengeResponderOptions {
  /** Runtime 自持签名身份（私钥不出进程）。 */
  signingIdentity: JwsSigningIdentity;
  /** 本实例的商家/agent/代次：挑战必须与之一致。 */
  expectedMerchantId: string;
  expectedAgentId: string;
  currentGeneration: number;
  /** 应答过的一次性记录（默认进程内）。 */
  store?: BindingChallengeStore;
  /** 每分钟最多应答次数（缺省 30；防刷）。 */
  maxPerMinute?: number;
  now?: () => Date;
}

const MAX_BODY_BYTES = 64 * 1024;

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return undefined;
  return JSON.parse(text) as unknown;
}

/** 结构校验：挑战必须完整且字段类型正确（不接受"尽力解析"）。 */
function parseChallenge(value: unknown): BindingChallenge | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : undefined;
  const purpose = record["purpose"];
  const generation = record["generation"];
  const challengeId = str("challenge_id");
  const nonce = str("nonce");
  const agentId = str("agent_id");
  const merchantId = str("merchant_id");
  const origin = str("origin");
  const path = str("path");
  const thumbprint = str("key_thumbprint");
  const issuedAt = str("issued_at");
  const expiresAt = str("expires_at");
  if (
    (purpose !== "endpoint" && purpose !== "key-custody") ||
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    challengeId === undefined ||
    nonce === undefined ||
    agentId === undefined ||
    merchantId === undefined ||
    origin === undefined ||
    path === undefined ||
    thumbprint === undefined ||
    !isThumbprint(thumbprint) ||
    issuedAt === undefined ||
    expiresAt === undefined
  ) {
    return undefined;
  }
  return {
    challenge_id: challengeId,
    purpose,
    nonce,
    agent_id: agentId,
    merchant_id: merchantId,
    origin,
    path,
    key_thumbprint: thumbprint,
    generation,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
}

/**
 * 构造 `/control/challenge` 处理器：接收挑战 → 返回受限结构签名证明。
 * 任何不符（指纹不是本实例、代次不符、过期、重放、超速）都明确拒绝。
 */
export function createChallengeResponder(
  options: ChallengeResponderOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const store = options.store ?? new BindingChallengeStore();
  const now = options.now ?? (() => new Date());
  const maxPerMinute = options.maxPerMinute ?? 30;
  const hits: number[] = [];
  // 本实例公钥指纹：由自持私钥导出公钥计算（私钥不出进程）。
  const ownThumbprint = publicKeyThumbprint(
    createPublicKey(options.signingIdentity.privateKey).export({ type: "spki", format: "pem" }) as string,
  );

  return (req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      const nowMs = now().getTime();
      while (hits.length > 0 && nowMs - (hits[0] ?? 0) > 60_000) hits.shift();
      if (hits.length >= maxPerMinute) {
        writeJson(res, 429, { error: "rate_limited", message: "挑战应答过于频繁" });
        return;
      }
      hits.push(nowMs);

      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        writeJson(res, 400, { error: "invalid_request", message: "请求体不是合法 JSON" });
        return;
      }
      const raw = (body as { challenge?: unknown } | undefined)?.challenge;
      const challenge = parseChallenge(raw);
      if (challenge === undefined) {
        writeJson(res, 400, { error: "invalid_challenge", message: "挑战结构不完整或字段非法" });
        return;
      }
      // 挑战必须发给**本实例**：指纹不符即拒绝（不替他人签名）。
      if (challenge.key_thumbprint !== ownThumbprint) {
        writeJson(res, 403, {
          error: "thumbprint_mismatch",
          message: "该挑战不属于本实例的公钥指纹",
        });
        return;
      }
      if (challenge.merchant_id !== options.expectedMerchantId || challenge.agent_id !== options.expectedAgentId) {
        writeJson(res, 403, { error: "identity_mismatch", message: "挑战的商家/agent 与本实例不一致" });
        return;
      }
      if (challenge.generation !== options.currentGeneration) {
        writeJson(res, 409, { error: "generation_mismatch", message: "挑战属于其它部署代次" });
        return;
      }
      if (Date.parse(challenge.expires_at) <= nowMs) {
        writeJson(res, 403, { error: "challenge_expired", message: "挑战已过期" });
        return;
      }
      if (store.isConsumed(challenge.challenge_id)) {
        writeJson(res, 409, { error: "challenge_replayed", message: "该挑战已应答过" });
        return;
      }
      let proof: string;
      try {
        proof = signBindingChallenge(challenge, options.signingIdentity);
      } catch (err) {
        const detail = err instanceof BindingProofError ? err.code : "sign_failed";
        writeJson(res, 500, { error: "sign_failed", message: detail });
        return;
      }
      store.consume(challenge.challenge_id, now().toISOString());
      writeJson(res, 200, {
        proof_jws: proof,
        key_id: options.signingIdentity.keyid,
        key_thumbprint: ownThumbprint,
        subject_digest: challengeSubjectDigest(challenge),
      });
    })().catch(() => {
      if (!res.headersSent) writeJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  };
}

/** 挑战主体的 sha256（用于回执对账；不泄露挑战之外的信息）。 */
function challengeSubjectDigest(challenge: BindingChallenge): string {
  return `sha256:${createHash("sha256").update(challengeSubject(challenge), "utf8").digest("hex")}`;
}
