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
 * 绑定所需的**证明**（设计 v0.1.2 §6.3 / §11.4）：商家授权、Runtime 持钥、端点挑战。
 *
 * 三类证明都是"可核验的事实"，不是自述：
 *   1. 商家授权（merchant authorization）：来自已登录门户会话或一次性配对码，
 *      绑定 merchant_id / intent_id / generation；
 *   2. 持钥证明（key custody）：Runtime 用**自己的私钥**对一次性 nonce 签名，
 *      证明它确实持有绑定声明里那个公钥对应的私钥；
 *   3. 端点挑战（endpoint challenge）：绑定预期 origin/path/agent_id/公钥指纹，
 *      对实际公网端点发起，一次性、有 TTL。
 *
 * 设计约束（§11.4）：
 *   - 挑战签名是**受限结构**：签名内容固定为挑战主体（含 origin/path/agent_id/
 *     指纹/nonce/有效期），Runtime 不会成为"任意内容签名服务"；
 *   - 一次性消费：同一 challenge_id 成功核验后即失效，重放拒绝；
 *   - 过期拒绝；跨 origin/path/agent_id/指纹一律拒绝。
 *
 * 本模块只做"挑战与证明"的密码学与状态；谁有权发起、签发给谁由 issuance.ts 决定。
 */

import { createHash, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { signCompactJws, verifyCompactJws, JwsError, type JwsSigningIdentity } from "../../trust/identity/jws.js";
import type { JsonWebKey } from "../../trust/identity/jwk.js";
import { isThumbprint, jwkThumbprint } from "./thumbprint.js";

export type ChallengePurpose = "endpoint" | "key-custody";

export interface BindingChallenge {
  challenge_id: string;
  purpose: ChallengePurpose;
  /** 验收方（Catalog）定义的 nonce：一次性、不可预测。 */
  nonce: string;
  agent_id: string;
  merchant_id: string;
  /** 该绑定允许的 origin（端点挑战必须精确匹配）。 */
  origin: string;
  /** 该绑定允许的 A2A 路径（端点挑战必须精确匹配）。 */
  path: string;
  /** 期望的 Runtime 公钥指纹（key custody 用它锁定"是这把钥匙"）。 */
  key_thumbprint: string;
  /** 绑定代次：换代次后旧挑战不再有效。 */
  generation: number;
  issued_at: string;
  expires_at: string;
}

export class BindingProofError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BindingProofError";
    this.code = code;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 挑战主体（受限结构）：被签名的**完整**内容，成员名字典序固定。 */
export function challengeSubject(challenge: BindingChallenge): string {
  return JSON.stringify({
    agent_id: challenge.agent_id,
    challenge_id: challenge.challenge_id,
    expires_at: challenge.expires_at,
    generation: challenge.generation,
    issued_at: challenge.issued_at,
    key_thumbprint: challenge.key_thumbprint,
    merchant_id: challenge.merchant_id,
    nonce: challenge.nonce,
    origin: challenge.origin,
    path: challenge.path,
    purpose: challenge.purpose,
  });
}

export interface CreateChallengeInput {
  purpose: ChallengePurpose;
  agentId: string;
  merchantId: string;
  origin: string;
  path: string;
  keyThumbprint: string;
  generation: number;
  ttlSeconds?: number;
  now?: () => Date;
}

const DEFAULT_CHALLENGE_TTL_SECONDS = 300;

/** 选择默认 TTL（端点挑战 5 分钟；持钥证明同档，设计未给更细参数）。 */
export function createBindingChallenge(input: CreateChallengeInput): BindingChallenge {
  if (!isThumbprint(input.keyThumbprint)) {
    throw new BindingProofError("INVALID_THUMBPRINT", `key_thumbprint 形状非法：${input.keyThumbprint}`);
  }
  if (!/^https:\/\/[^/]+$/.test(input.origin)) {
    throw new BindingProofError("INVALID_ORIGIN", `origin 必须是 https origin：${input.origin}`);
  }
  if (!input.path.startsWith("/")) {
    throw new BindingProofError("INVALID_PATH", `path 必须以 / 开头：${input.path}`);
  }
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    throw new BindingProofError("INVALID_GENERATION", `generation 必须是正整数：${input.generation}`);
  }
  const now = input.now ?? (() => new Date());
  const issuedAt = now();
  const ttl = input.ttlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new BindingProofError("INVALID_TTL", `ttlSeconds 必须是正数：${ttl}`);
  }
  return {
    challenge_id: `chl_${randomBytes(12).toString("hex")}`,
    purpose: input.purpose,
    nonce: randomBytes(24).toString("base64url"),
    agent_id: input.agentId,
    merchant_id: input.merchantId,
    origin: input.origin,
    path: input.path,
    key_thumbprint: input.keyThumbprint,
    generation: input.generation,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + ttl * 1000).toISOString(),
  };
}

/** Runtime 侧：用自持私钥对挑战主体签名（受限结构，不是任意内容签名）。 */
export function signBindingChallenge(
  challenge: BindingChallenge,
  identity: JwsSigningIdentity,
): string {
  return signCompactJws(challengeSubject(challenge), identity, { extraHeader: { typ: "kiwi-binding-proof" } });
}

export interface VerifyChallengeOptions {
  /** 验收方时钟（可注入）。 */
  now?: () => Date;
  /** 期望的签名 kid（可选；给出时强制比对——用于验收方有可信 kid 名单的场景）。 */
  expectedKeyId?: string;
  /** 允许的算法（缺省仅 EdDSA；设计 §11.4 固定 Ed25519/EdDSA）。 */
  allowedAlg?: readonly string[];
}

export interface VerifiedChallengeProof {
  challenge_id: string;
  purpose: ChallengePurpose;
  key_id: string;
  key_thumbprint: string;
  merchant_id: string;
  agent_id: string;
  generation: number;
  verified_at: string;
}

/**
 * 验收方：核验挑战证明。**失败一律拒绝**，不返回"部分可信"。
 * 校验：签名算法固定 EdDSA → 公钥指纹与挑战一致 → 签名有效 → 负载等于挑战主体
 * → 未过期 → 未被消费。成功后原子消费（同一 challenge_id 只能成功一次）。
 */
export class BindingChallengeStore {
  private readonly consumed = new Map<string, string>();

  /** 消费挑战：返回 false 表示已被消费（重放）。 */
  consume(challengeId: string, at: string): boolean {
    if (this.consumed.has(challengeId)) return false;
    this.consumed.set(challengeId, at);
    return true;
  }

  isConsumed(challengeId: string): boolean {
    return this.consumed.has(challengeId);
  }

  /** 清理过期消费记录（保留窗口由调用方决定）。 */
  prune(before: string): number {
    let removed = 0;
    for (const [id, at] of this.consumed) {
      if (at < before) {
        this.consumed.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

export function verifyBindingChallengeProof(input: {
  challenge: BindingChallenge;
  proofJws: string;
  /** 声明方提供的公钥（来自请求；必须与挑战内指纹一致才继续验签）。 */
  publicKey: JsonWebKey | KeyObject;
  store: BindingChallengeStore;
  options?: VerifyChallengeOptions;
}): VerifiedChallengeProof {
  const { challenge, proofJws, publicKey, store } = input;
  const options = input.options ?? {};
  const now = (options.now ?? (() => new Date()))();
  const allowedAlg = options.allowedAlg ?? ["EdDSA"];

  // 1) 公钥指纹必须与挑战一致（先钉死"是这把钥匙"，再验签）。
  const jwk: JsonWebKey =
    publicKey instanceof Object && "kty" in publicKey
      ? (publicKey as JsonWebKey)
      : ((publicKey as KeyObject).export({ format: "jwk" }) as JsonWebKey);
  const thumbprint = jwkThumbprint(jwk);
  if (thumbprint !== challenge.key_thumbprint) {
    throw new BindingProofError(
      "THUMBPRINT_MISMATCH",
      `证明公钥指纹 ${thumbprint} 与挑战要求 ${challenge.key_thumbprint} 不一致`,
    );
  }

  // 2) 过期即拒绝（先判时间，避免对过期挑战做无谓验签）。
  if (Date.parse(challenge.expires_at) <= now.getTime()) {
    throw new BindingProofError("CHALLENGE_EXPIRED", `挑战已过期：${challenge.challenge_id}`);
  }

  // 3) 验签（算法固定；未知算法由 verifyCompactJws 抛 unsupported_algorithm）。
  let payload: Buffer;
  let keyid: string | undefined;
  try {
    const verified = verifyCompactJws(proofJws, jwk);
    if (!allowedAlg.includes(verified.alg)) {
      throw new BindingProofError(
        "ALGORITHM_NOT_ALLOWED",
        `证明算法 ${verified.alg} 不在允许集合 ${allowedAlg.join(",")}`,
      );
    }
    payload = verified.payload;
    keyid = verified.keyid;
  } catch (err) {
    if (err instanceof BindingProofError) throw err;
    if (err instanceof JwsError) {
      throw new BindingProofError(`JWS_${err.code.toUpperCase()}`, err.message);
    }
    throw err;
  }

  // 4) 负载必须**恰好**是挑战主体（受限结构，防任意内容签名）。
  if (payload.toString("utf8") !== challengeSubject(challenge)) {
    throw new BindingProofError("SUBJECT_MISMATCH", "证明内容与挑战主体不一致（受限结构校验失败）");
  }
  // kid 语义（§11.4「由可信 kid 选择验证公钥」）：本流程的公钥是**按指纹钉死**的
  // （比按 kid 选择更强），因此 kid 只在验收方显式给出期望值时强制比对；
  // 未给出时不做「kid 必须等于 agent_id/指纹」的推断——keyid 是不透明标签
  // （云端实现里 keyid 是公网 origin），拿它当身份会误拒合法证明。
  if (options.expectedKeyId !== undefined && keyid !== options.expectedKeyId) {
    throw new BindingProofError("KID_MISMATCH", `证明 kid=${keyid} 期望 ${options.expectedKeyId}`);
  }

  // 5) 一次性消费（原子：同一挑战第二次成功核验必须失败）。
  const verifiedAt = now.toISOString();
  if (!store.consume(challenge.challenge_id, verifiedAt)) {
    throw new BindingProofError("CHALLENGE_REPLAYED", `挑战已被消费：${challenge.challenge_id}`);
  }

  return {
    challenge_id: challenge.challenge_id,
    purpose: challenge.purpose,
    key_id: keyid ?? challenge.key_thumbprint,
    key_thumbprint: thumbprint,
    merchant_id: challenge.merchant_id,
    agent_id: challenge.agent_id,
    generation: challenge.generation,
    verified_at: verifiedAt,
  };
}

/** 商家授权记录（来自门户会话或一次性配对码；由调用方核验来源后传入）。 */
export interface MerchantAuthorizationProof {
  merchant_id: string;
  intent_id: string;
  generation: number;
  /** 授权渠道：门户登录会话 / 一次性配对码（短 TTL、单次消费）。 */
  method: "portal_session" | "pairing_code";
  authorized_at: string;
  /** 该授权绑定的公钥指纹（与待签发声明的 key_thumbprint 必须一致）。 */
  key_thumbprint: string;
}

/** 授权摘要（审计用；不含任何凭据）。 */
export function authorizationFingerprint(auth: MerchantAuthorizationProof): string {
  return sha256Hex(
    [auth.merchant_id, auth.intent_id, String(auth.generation), auth.key_thumbprint, auth.method].join("\u0000"),
  );
}
