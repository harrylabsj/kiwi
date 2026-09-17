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
 * Merchant MCP 的 OAuth 授权校验（V2 阶段一）。
 *
 * 在 MerchantMcpAuthVerifier 接缝上叠加 OAuth Bearer 校验：access_token 查
 * 授权服务器 store（签发方本服务、有效期、未撤销），并返回 principal/scope
 * 授权上下文。租户隔离（前置决策 3）：token 在签发时绑定 merchant_id，校验
 * 时必须等于本实例的 expectedMerchantId——用户参数不能选择任意 merchant_id，
 * 跨商家访问一律拒绝。
 *
 * scope 设计：merchant:read（只读工具）/ merchant:write（写类工具，本轮仅
 * 审批候选生成）。本轮接入校验；tools/list 按 scope 过滤留给后续波次。
 */

import type { MerchantOAuthStore } from "./merchant-oauth.js";
import type {
  MerchantMcpAuthContext,
  MerchantMcpAuthResult,
  MerchantMcpAuthVerifier,
} from "../mcp/merchant-auth.js";

/** 本服务支持的 scope（读/写两类；写类工具要求 merchant:write）。 */
export const MERCHANT_OAUTH_SCOPES = ["merchant:read", "merchant:write"] as const;
export type MerchantOAuthScope = (typeof MERCHANT_OAUTH_SCOPES)[number];

/** 校验通过的授权上下文（principal/merchant/scope；供 tools 过滤与审计）。 */
export interface MerchantAuthorization {
  principal_id: string;
  merchant_id: string;
  scopes: string[];
}

export class MerchantOAuthVerifier implements MerchantMcpAuthVerifier {
  readonly name = "oauth-bearer";
  private readonly store: MerchantOAuthStore;
  private readonly expectedMerchantId: string | undefined;

  constructor(options: { store: MerchantOAuthStore; expectedMerchantId?: string; multiMerchant?: boolean }) {
    if (options.multiMerchant === true) {
      if (options.expectedMerchantId !== undefined) {
        throw new Error("通用 OAuth 校验器不能同时固定 expectedMerchantId");
      }
    } else if (!options.expectedMerchantId) {
      throw new Error("单商家 OAuth 校验器必须配置 expectedMerchantId；通用网关须显式 multiMerchant=true");
    }
    this.store = options.store;
    this.expectedMerchantId = options.expectedMerchantId;
  }

  verify(ctx: MerchantMcpAuthContext): MerchantMcpAuthResult {
    const header = ctx.authorizationHeader;
    if (header === undefined || header === "") {
      return { ok: false, reason: "missing Authorization header" };
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) {
      return { ok: false, reason: "Authorization header is not a bearer token" };
    }
    const token = this.store.getAccessToken(match[1] ?? "");
    if (token === undefined) {
      return { ok: false, reason: "invalid or expired access token" };
    }
    // 租户校验（前置决策 3）：token 签发给哪个商家就只能访问哪个商家。
    if (this.expectedMerchantId !== undefined && token.merchant_id !== this.expectedMerchantId) {
      return { ok: false, reason: "token merchant 不属于本实例（租户越权拒绝）" };
    }
    return {
      ok: true,
      authorization: {
        principal_id: token.principal_id,
        merchant_id: token.merchant_id,
        scopes: token.scope,
      },
    };
  }
}
