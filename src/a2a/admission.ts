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
 * A2A 陌生调用者准入策略（与“认证模式”分开）。
 *
 * `signature` 认证模式本身允许匿名 T0（为开放互操作），因此“是否接待陌生
 * 买家”必须由独立策略决定：
 * - open：匿名、询价会话、签名身份都放行（当前行为，保持兼容）；
 * - verified：拒绝基础匿名身份；签名身份与公开询价会话放行；
 * - closed：只允许已验证身份；匿名与公开询价会话都拒绝。
 *
 * 该策略只决定“请求能否进入协议处理”，业务授权（能读哪一单、能做什么）
 * 仍由服务端主体与任务归属检查负责。
 */

import { isAnonymousIdentity } from "./server/identity.js";
import { OPEN_INQUIRY_IDENTITY_PREFIX } from "./open-inquiry-identity.js";
import type { AuthContext, AuthResult, AuthVerifier } from "./server/types.js";

export type A2aAdmissionPolicy = "open" | "verified" | "closed";

const POLICIES: readonly A2aAdmissionPolicy[] = ["open", "verified", "closed"];

/** 解析准入策略；未设置时保持当前行为 open，非法值 fail-closed。 */
export function parseA2aAdmissionPolicy(raw: unknown): A2aAdmissionPolicy {
  if (raw === undefined || raw === null || raw === "") return "open";
  if (typeof raw !== "string" || !(POLICIES as readonly string[]).includes(raw)) {
    throw new Error(`A2A 准入策略非法：${String(raw)}（可选 open | verified | closed）`);
  }
  return raw as A2aAdmissionPolicy;
}

function deny(reason: string): AuthResult {
  return { authenticated: false, protocolCode: "authorization_failed", reason };
}

/**
 * 在认证结果之上执行准入策略。
 *
 * - 认证失败原样返回（由底层给出协议错误码）；
 * - open 原样放行；
 * - verified 拒绝基础匿名（identity 为空或 anonymous）；
 * - closed 额外拒绝公开询价会话身份；
 * - 已验证的签名身份始终放行。
 */
export class AdmissionPolicyVerifier implements AuthVerifier {
  readonly name: string;

  constructor(
    private readonly delegate: AuthVerifier,
    private readonly policy: A2aAdmissionPolicy,
  ) {
    this.name = `admission:${policy}`;
  }

  async verify(ctx: AuthContext): Promise<AuthResult> {
    const result = await this.delegate.verify(ctx);
    if (!result.authenticated || this.policy === "open") return result;
    const identity = result.identity ?? "";
    const anonymous = isAnonymousIdentity(identity);
    if (anonymous) return deny("anonymous access denied by admission policy");
    if (this.policy === "closed" && identity.startsWith(OPEN_INQUIRY_IDENTITY_PREFIX)) {
      return deny("open inquiry session denied by admission policy");
    }
    return result;
  }
}
