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
 * 匿名身份判定单一来源（审查 P2：一处支持 `anonymous:` 前缀、另一处只认
 * 字面量 "anonymous" 会让准入策略与任务权限口径分裂）。
 *
 * `anonymous:<hash>` 是派生匿名身份（按来源地址 + 实例盐）；任何以
 * `anonymous` 开头的身份都不属于可共享的私有主体。
 */
export function isAnonymousIdentity(identity: string | undefined | null): boolean {
  const value = String(identity ?? "").trim();
  return value === "" || value === "anonymous" || value.startsWith("anonymous:");
}
