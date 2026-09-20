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
 * 绑定声明的**验收方**（设计 v0.1.2 §11.4 / §12.1；SIG-03）。
 *
 * Buyer 只信任**本地预配置**的 Catalog 发行者及其轮换规则：`kid → 公钥` 必须由
 * 调用方从受控来源（发布包/管理员配置）提供，**绝不**根据声明里的任意 URL 去下载
 * 信任根（未知 kid 不是取根的理由）。
 *
 * 验证顺序（任一失败即拒绝，不返回"部分可信"）：
 *   1. 解析 JWS，取 kid → 从可信存储取公钥；未知 kid → 拒绝；
 *   2. 算法固定（缺省仅 EdDSA），拒绝 none/回退；
 *   3. 验签（篡改即失败）；
 *   4. 完整 claims 校验（结构/格式/有效期上限/未知字段）；
 *   5. 时间窗（未生效/已过期）；
 *   6. scope 必须是 a2a-runtime；status 必须 active（revoked 一律拒绝）；
 *   7. 与**观测事实**逐项比对（agent_id / Card URL / A2A 端点 / origin / 公钥指纹 /
 *      merchant_id / service_epoch / binding_id / binding_version）。
 *
 * 比对的意义：声明必须描述" Buyer 实际连的那个商家"，而不是"某个其它商家"。
 */

import type { KeyObject } from "node:crypto";
import type { JsonWebKey } from "../identity/jwk.js";
import type { SigningKey } from "../identity/keys.js";
import { JwsError, verifyCompactJws } from "../identity/jws.js";
import { validateBindingClaims, type BindingClaims } from "./claims.js";

/** 可信发行者存储：kid → 公钥（本地预配置；不得从声明内容推导）。 */
export interface BindingTrustStore {
  resolveIssuerKey: (kid: string) => SigningKey | JsonWebKey | KeyObject | undefined;
}

export interface ExpectedBindingFacts {
  agentId?: string;
  cardUrl?: string;
  a2aEndpoint?: string;
  runtimeOrigin?: string;
  keyThumbprint?: string;
  merchantId?: string;
  serviceEpoch?: number;
  bindingId?: string;
  /** 最低可接受的 binding_version（拒绝旧绑定回放）。 */
  minBindingVersion?: number;
}

export interface VerifyBindingOptions {
  trust: BindingTrustStore;
  /** 观测事实（省略的字段不做比对）。 */
  expected?: ExpectedBindingFacts;
  now?: () => Date;
  /** 允许的算法（缺省仅 EdDSA；设计固定 Ed25519/EdDSA）。 */
  allowedAlg?: readonly string[];
}

export type VerifyBindingRefusalCode =
  | "MALFORMED"
  | "UNKNOWN_ISSUER"
  | "ALGORITHM_NOT_ALLOWED"
  | "BAD_SIGNATURE"
  | "CLAIMS_INVALID"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "SCOPE_MISMATCH"
  | "REVOKED"
  | "AGENT_MISMATCH"
  | "CARD_URL_MISMATCH"
  | "ENDPOINT_MISMATCH"
  | "ORIGIN_MISMATCH"
  | "THUMBPRINT_MISMATCH"
  | "MERCHANT_MISMATCH"
  | "SERVICE_EPOCH_MISMATCH"
  | "BINDING_ID_MISMATCH"
  | "BINDING_VERSION_TOO_OLD";

export type VerifyBindingResult =
  | { ok: true; claims: BindingClaims; issuer_kid: string }
  | { ok: false; code: VerifyBindingRefusalCode; reason: string };

const refuse = (code: VerifyBindingRefusalCode, reason: string): VerifyBindingResult => ({
  ok: false,
  code,
  reason,
});

export function verifyBindingClaims(
  jws: string,
  options: VerifyBindingOptions,
): VerifyBindingResult {
  const now = (options.now ?? (() => new Date()))();
  const allowedAlg = options.allowedAlg ?? ["EdDSA"];
  const expected = options.expected ?? {};

  // 1) kid → 可信公钥（不经任何网络）
  const headerKid = (() => {
    const firstDot = jws.indexOf(".");
    if (firstDot <= 0) return undefined;
    try {
      const header = JSON.parse(Buffer.from(jws.slice(0, firstDot), "base64url").toString("utf8")) as {
        kid?: unknown;
      };
      return typeof header.kid === "string" ? header.kid : undefined;
    } catch {
      return undefined;
    }
  })();
  if (headerKid === undefined) return refuse("MALFORMED", "声明缺少 kid（无法选择可信公钥）");
  const publicKey = options.trust.resolveIssuerKey(headerKid);
  if (publicKey === undefined) {
    return refuse("UNKNOWN_ISSUER", `未知发行者 kid=${headerKid}（不得据声明内容下载信任根）`);
  }

  // 2/3) 算法固定 + 验签
  let payload: Buffer;
  try {
    const verified = verifyCompactJws(jws, publicKey);
    if (!allowedAlg.includes(verified.alg)) {
      return refuse("ALGORITHM_NOT_ALLOWED", `声明算法 ${verified.alg} 不在允许集合 ${allowedAlg.join(",")}`);
    }
    payload = verified.payload;
  } catch (err) {
    if (err instanceof JwsError) {
      return refuse(err.code === "invalid_signature" ? "BAD_SIGNATURE" : "MALFORMED", err.message);
    }
    throw err;
  }

  // 4) 完整 claims 校验
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return refuse("CLAIMS_INVALID", "声明负载不是合法 JSON");
  }
  const validated = validateBindingClaims(parsed);
  if (!validated.ok) return refuse("CLAIMS_INVALID", validated.errors.join("；"));
  const claims = validated.claims;

  // 5) 时间窗
  if (Date.parse(claims.issued_at) > now.getTime() + 60_000) {
    return refuse("NOT_YET_VALID", `声明尚未生效（issued_at=${claims.issued_at}）`);
  }
  if (Date.parse(claims.expires_at) <= now.getTime()) {
    return refuse("EXPIRED", `声明已过期（expires_at=${claims.expires_at}）`);
  }

  // 6) scope / 治理状态
  if (claims.scope !== "a2a-runtime") return refuse("SCOPE_MISMATCH", `scope=${claims.scope}`);
  if (claims.status !== "active") return refuse("REVOKED", `声明状态=${claims.status}`);

  // 7) 与观测事实逐项比对
  const compare = (
    field: keyof ExpectedBindingFacts,
    actual: string | number | undefined,
    code: VerifyBindingRefusalCode,
  ): VerifyBindingResult | undefined => {
    const want = expected[field];
    if (want === undefined || actual === undefined) return undefined;
    if (want !== actual) return refuse(code, `${String(field)}=${String(actual)} 与观测事实 ${String(want)} 不一致`);
    return undefined;
  };
  for (const [field, actual, code] of [
    ["agentId", claims.agent_id, "AGENT_MISMATCH"],
    ["cardUrl", claims.card_url, "CARD_URL_MISMATCH"],
    ["a2aEndpoint", claims.a2a_endpoint, "ENDPOINT_MISMATCH"],
    ["runtimeOrigin", claims.runtime_origin, "ORIGIN_MISMATCH"],
    ["keyThumbprint", claims.key_thumbprint, "THUMBPRINT_MISMATCH"],
    ["merchantId", claims.merchant_id, "MERCHANT_MISMATCH"],
    ["serviceEpoch", claims.service_epoch, "SERVICE_EPOCH_MISMATCH"],
    ["bindingId", claims.binding_id, "BINDING_ID_MISMATCH"],
  ] as const) {
    const mismatch = compare(field, actual, code);
    if (mismatch !== undefined) return mismatch;
  }
  if (
    expected.minBindingVersion !== undefined &&
    claims.binding_version < expected.minBindingVersion
  ) {
    return refuse(
      "BINDING_VERSION_TOO_OLD",
      `binding_version=${claims.binding_version} 低于可接受下限 ${expected.minBindingVersion}（旧绑定回放）`,
    );
  }

  return { ok: true, claims, issuer_kid: headerKid };
}

/**
 * 信任缓存键（§12.1）：按「目录来源 + Card revision + binding_version + 端点身份」
 * 联合索引——**不按 Catalog hostname 索引所有商家**（那会把不同商家混成一个身份）。
 */
export function trustCacheKey(input: {
  source: string;
  agentId: string;
  cardRevision: number;
  bindingVersion: number;
  endpoint: string;
}): string {
  return [input.source, input.agentId, String(input.cardRevision), String(input.bindingVersion), input.endpoint].join(
    "\u0000",
  );
}
