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
 * 商家实例 OAuth scope 词表（单实例 MCP）。
 *
 * 独立成模块，避免 MCP 工具层为了一个常量引入整个 OAuth 服务器实现。
 */

/** 读取商家实例商品、报价规则与磋商。 */
export const MERCHANT_READ_SCOPE = "merchant:read";

/** 执行商家写操作（仍需逐次确认）。 */
export const MERCHANT_WRITE_SCOPE = "merchant:write";

/**
 * 店主金额 scope：**不在缺省 scope 中**，实例必须显式启用，客户端必须显式
 * 申请，且管理会话角色为 owner 才签发。
 */
export const MERCHANT_OWNER_SCOPE = "merchant:owner";

/** 单实例缺省 scope（与 MerchantOAuthServer 的历史默认一致）。 */
export const DEFAULT_MERCHANT_SCOPES: readonly string[] = [
  MERCHANT_READ_SCOPE,
  MERCHANT_WRITE_SCOPE,
];

/** 按实例配置生成 OAuth scope 白名单；owner 默认关闭。 */
export function merchantOAuthScopes(ownerEnabled: boolean): string[] {
  return ownerEnabled ? [...DEFAULT_MERCHANT_SCOPES, MERCHANT_OWNER_SCOPE] : [...DEFAULT_MERCHANT_SCOPES];
}
