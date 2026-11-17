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
 * 纠正正文入库前预检（设计 §5.1 / §21.1 / A03 / A13）。
 *
 * 客户标识、联系方式、凭据和价格底线不得进入学习域：命中即拒绝（不静默
 * 保存），并只登记原因与摘要。检测是保守的启发式——宁可要求商家改写为
 * 抽象流程纠正，也不把敏感原文送进模型或候选。
 *
 * 明确边界：姓名、模糊地址等低结构信息无法可靠识别；产品约束是纠正正文
 * 只描述抽象流程，客户案例通过 `case_refs` 引用已授权案例，不内联原文。
 */

export type CorrectionSensitiveReason =
  | "phone"
  | "email"
  | "id_card"
  | "credential"
  | "floor_price"
  | "address";

const PHONE_PATTERNS: readonly RegExp[] = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/u,
  /(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/u,
  /(?<!\d)\+\d{1,3}[ -]?\d{6,14}(?!\d)/u,
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
const ID_CARD_PATTERN = /(?<!\d)\d{17}[\dXx](?!\d)/u;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/u,
  /\bAKIA[0-9A-Z]{12,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}/u,
  /\b(api[_-]?key|access[_-]?token|secret|password|passwd)\s*[:=]\s*\S{6,}/iu,
  /(密码|密钥|凭据|令牌)\s*[:：=]\s*\S{4,}/u,
];

const HARD_FLOOR_PRICE_PATTERN =
  /(底价|成本价|进价|出厂价|最低可售|最低成交价|floor\s*price|cost\s*price)/iu;
const SOFT_FLOOR_PRICE_PATTERN = /最低价\s*[:：]?\s*[¥￥]?\s*\d/u;

const ADDRESS_PATTERN =
  /(详细地址|收货地址|家庭住址|门牌号|地址\s*[:：]\s*\S{6,})/u;

/** 控制字符（允许换行与制表）；用于正文与 ID 的形状校验。 */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * 返回首个命中的敏感类别；`undefined` 表示通过预检。
 * 顺序固定，便于审计与稳定原因码。
 */
export function detectCorrectionSensitiveContent(
  text: string,
): CorrectionSensitiveReason | undefined {
  if (PHONE_PATTERNS.some((pattern) => pattern.test(text))) return "phone";
  if (EMAIL_PATTERN.test(text)) return "email";
  if (ID_CARD_PATTERN.test(text)) return "id_card";
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) return "credential";
  if (HARD_FLOOR_PRICE_PATTERN.test(text) || SOFT_FLOOR_PRICE_PATTERN.test(text)) {
    return "floor_price";
  }
  if (ADDRESS_PATTERN.test(text)) return "address";
  return undefined;
}
