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
 * SIG-02 受控签发（设计 v0.1.2 §11.4 / §11.6）。
 *
 * **只**对同时满足下列条件的绑定签发声明，任一不满足即拒绝（fail-closed，绝不签发）：
 *   1. 商家授权（门户会话或一次性配对码）——且授权的 merchant/intent/generation/
 *      公钥指纹必须与本次待签声明一致（跨商家、异代次、换钥匙一律拒绝）；
 *   2. Runtime 持钥证明（key custody）——一次性挑战，证明实例确实持有对应私钥；
 *   3. 端点挑战（endpoint challenge）——绑定预期 origin/path/agent_id/指纹；
 *   4. 当前 generation 与治理状态复核（active；paused/revoked 一律不签）；
 *   5. 撤销集复核（SIG-05）——已撤销的绑定或密钥指纹不得因恢复而重新生效；
 *   6. claims 完整校验（Schema 一致性 + 有效期上限）。
 *
 * 本模块是**参考实现 + 验收测试载体**：生产发行者是 Catalog（M3 在 kiwi-catalog
 * 侧实现同一契约，跨语言摘要口径由 thumbprint.ts 锁定）。把它放在 kiwi 里是为了
 * 让「签发 → 验证 → 拒绝」能在本地被真实密码学测试覆盖（设计要求的真实测试密钥
 * 签发/验证、篡改、过期、未授权签发等）。
 */

import type { JwsSigningIdentity } from "../../trust/identity/jws.js";
import { signCompactJws } from "../../trust/identity/jws.js";
import { BindingAuditLog, RevocationSet } from "./audit.js";
import { buildBindingClaims, validateBindingClaims, type BindingClaims, type BuildBindingClaimsInput } from "../../trust/binding/claims.js";
import type { MerchantAuthorizationProof, VerifiedChallengeProof } from "./proofs.js";

export type IssuanceRefusalCode =
  | "MISSING_AUTHORIZATION"
  | "AUTHORIZATION_MERCHANT_MISMATCH"
  | "AUTHORIZATION_GENERATION_MISMATCH"
  | "AUTHORIZATION_THUMBPRINT_MISMATCH"
  | "MISSING_KEY_CUSTODY"
  | "MISSING_ENDPOINT_CHALLENGE"
  | "KEY_CUSTODY_MISMATCH"
  | "ENDPOINT_CHALLENGE_MISMATCH"
  | "GENERATION_MISMATCH"
  | "GOVERNANCE_NOT_ACTIVE"
  | "SERVICE_EPOCH_MISMATCH"
  | "BINDING_REVOKED"
  | "CLAIMS_INVALID";

export interface IssuanceRequest {
  /** 待签声明输入（issuer/scope 由签发器决定，不接受调用方伪造）。 */
  claims: Omit<BuildBindingClaimsInput, "issuer" | "status" | "issuedAt" | "ttlSeconds"> & {
    issuedAt?: string;
    ttlSeconds?: number;
  };
  /** 商家授权证明（缺省视为未授权 → 拒绝签发）。 */
  authorization?: MerchantAuthorizationProof;
  keyCustody?: VerifiedChallengeProof;
  endpointChallenge?: VerifiedChallengeProof;
  /** 控制面当前代次与治理状态。 */
  currentGeneration: number;
  governance: { status: "active" | "paused" | "revoked"; service_epoch: number };
}

export interface IssuanceDeps {
  /** 发行者签名身份（Ed25519）。 */
  signer: JwsSigningIdentity;
  /** 发行者标识（写入 claims.issuer）。 */
  issuerId: string;
  /** 默认有效期（秒）；不得超过 claims 模块的上限。 */
  ttlSeconds?: number;
  audit?: BindingAuditLog;
  revocations?: RevocationSet;
  now?: () => Date;
}

export type IssuanceResult =
  | { ok: true; claims: BindingClaims; jws: string; key_thumbprint: string }
  | { ok: false; code: IssuanceRefusalCode; reason: string };

function refuse(
  code: IssuanceRefusalCode,
  reason: string,
  context: { request: IssuanceRequest; audit?: BindingAuditLog },
): IssuanceResult {
  context.audit?.append({
    event: "refused",
    binding_id: context.request.claims.bindingId,
    merchant_id: context.request.claims.merchantId,
    agent_id: context.request.claims.agentId,
    generation: context.request.currentGeneration,
    key_thumbprint: context.request.claims.keyThumbprint,
    code,
    note: reason,
  });
  return { ok: false, code, reason };
}

export function issueBindingClaims(request: IssuanceRequest, deps: IssuanceDeps): IssuanceResult {
  const now = (deps.now ?? (() => new Date()))();
  const audit = deps.audit;
  const ctx = { request, ...(audit !== undefined ? { audit } : {}) };
  const claims = request.claims;

  // 1) 商家授权
  const auth = request.authorization;
  if (auth === undefined) return refuse("MISSING_AUTHORIZATION", "缺少商家授权证明", ctx);
  if (auth.merchant_id !== claims.merchantId) {
    return refuse("AUTHORIZATION_MERCHANT_MISMATCH", "授权商家与待签声明的 merchant_id 不一致", ctx);
  }
  if (auth.generation !== request.currentGeneration) {
    return refuse("AUTHORIZATION_GENERATION_MISMATCH", "授权所属代次与当前代次不一致", ctx);
  }
  if (auth.key_thumbprint !== claims.keyThumbprint) {
    return refuse("AUTHORIZATION_THUMBPRINT_MISMATCH", "授权绑定的公钥指纹与待签声明不一致", ctx);
  }

  // 2) 持钥证明
  const custody = request.keyCustody;
  if (custody === undefined || custody.purpose !== "key-custody") {
    return refuse("MISSING_KEY_CUSTODY", "缺少 Runtime 持钥证明", ctx);
  }
  if (
    custody.key_thumbprint !== claims.keyThumbprint ||
    custody.agent_id !== claims.agentId ||
    custody.generation !== request.currentGeneration
  ) {
    return refuse("KEY_CUSTODY_MISMATCH", "持钥证明的身份/指纹/代次与待签声明不一致", ctx);
  }

  // 3) 端点挑战
  const endpoint = request.endpointChallenge;
  if (endpoint === undefined || endpoint.purpose !== "endpoint") {
    return refuse("MISSING_ENDPOINT_CHALLENGE", "缺少端点挑战证明", ctx);
  }
  if (
    endpoint.key_thumbprint !== claims.keyThumbprint ||
    endpoint.agent_id !== claims.agentId ||
    endpoint.generation !== request.currentGeneration
  ) {
    return refuse("ENDPOINT_CHALLENGE_MISMATCH", "端点挑战证明与待签声明不一致", ctx);
  }

  // 4) 代次与治理状态
  if (request.governance.status !== "active") {
    return refuse(
      "GOVERNANCE_NOT_ACTIVE",
      `治理状态为 ${request.governance.status}：不签发、不发布`,
      ctx,
    );
  }
  if (request.governance.service_epoch !== claims.serviceEpoch) {
    return refuse("SERVICE_EPOCH_MISMATCH", "service_epoch 与当前治理状态不一致", ctx);
  }

  // 5) 撤销集（SIG-05：恢复不得复活已撤销的绑定/密钥）
  if (deps.revocations !== undefined) {
    const revokedBinding = deps.revocations.byBinding(claims.bindingId);
    if (revokedBinding !== undefined) {
      return refuse("BINDING_REVOKED", `绑定已被撤销（${revokedBinding.reason}）`, ctx);
    }
    const revokedKey = deps.revocations.byThumbprint(claims.keyThumbprint);
    if (revokedKey !== undefined) {
      return refuse("BINDING_REVOKED", `该公钥指纹已被撤销（${revokedKey.reason}）`, ctx);
    }
  }

  // 6) claims 完整校验 + 构造（issuer 由签发器写入，不接受调用方指定）
  let built: BindingClaims;
  try {
    built = buildBindingClaims({
      ...claims,
      issuedAt: claims.issuedAt ?? now.toISOString(),
      ttlSeconds: claims.ttlSeconds ?? deps.ttlSeconds ?? 900,
      issuer: deps.issuerId,
      status: "active",
    });
  } catch (err) {
    return refuse("CLAIMS_INVALID", err instanceof Error ? err.message : String(err), ctx);
  }
  const checked = validateBindingClaims(built);
  if (!checked.ok) return refuse("CLAIMS_INVALID", checked.errors.join("；"), ctx);

  // 7) 签发（Ed25519/EdDSA；算法由密钥决定，不存在 none/回退）
  const jws = signCompactJws(built as unknown as Record<string, unknown>, deps.signer, {
    extraHeader: { typ: "kiwi-runtime-binding-claims" },
  });
  audit?.append({
    event: "issued",
    binding_id: built.binding_id,
    merchant_id: built.merchant_id,
    agent_id: built.agent_id,
    generation: request.currentGeneration,
    binding_version: built.binding_version,
    key_thumbprint: built.key_thumbprint,
    note: "签发绑定声明",
  });
  return { ok: true, claims: built, jws, key_thumbprint: built.key_thumbprint };
}
