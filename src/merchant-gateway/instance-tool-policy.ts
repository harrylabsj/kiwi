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
 * 共享网关是否代理商家实例私有工具（第 1 版 `kiwi_merchant_*`）。
 *
 * 默认关闭：WorkBuddy 的私有数据通道应直连商家实例，不经共享网关。
 * 历史部署如确需网关代理，必须显式设置 `KIWI_GATEWAY_INSTANCE_TOOLS=1`。
 */
export const GATEWAY_INSTANCE_TOOLS_ENV = "KIWI_GATEWAY_INSTANCE_TOOLS";

export function gatewayInstanceToolsEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return String(env[GATEWAY_INSTANCE_TOOLS_ENV] ?? "").trim() === "1";
}
