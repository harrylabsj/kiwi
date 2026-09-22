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
 * 落库前错误文本脱敏（P2-1 刀 3 同构去重）。
 *
 * 此前逐字/近似复制在三处（reconciliation-worker / external-delivery /
 * promotion-broadcast-workflow——盘点只数到前两处）：同一职责三份实现，改一处
 * 忘两处就是脱敏漏洞。唯一差异是正则 flag（`gi` vs `giu`）：统一为 `giu`——
 * 对本模式针对的 ASCII 秘密形状两者判定完全一致，`u` 只对非 ASCII 输入的
 * 大小写折叠有理论差异，取更正确的那一个。
 *
 * 注意与 `cloud/onboarding/store.ts` 的 `sanitizeError` 区分：那个额外脱
 * 私钥块与长 token，是开通域自己的更严格口径，不在本刀收敛范围。
 */

/** 脱敏并截断（审计/告警里不留秘密形状，不留长文本）。 */
export function sanitize(value: string): string {
  return String(value ?? "")
    .replace(/\b(Bearer|token|api[_-]?key|secret|password)\b\s*[:=]?\s*\S+/giu, "$1 [redacted]")
    .slice(0, 500);
}
