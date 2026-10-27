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
 * WorkBuddy 双地址（B-03，G1 契约 §2.5）。
 *
 * 平台网关在转发前校验并**剥除**分享参数，所以：
 *
 *   签名地址：https://merchant.example/a2a?业务参数        ← 签名覆盖它
 *   发送地址：https://merchant.example/a2a?业务参数&sharecode=…  ← 实际发出去
 *
 * 两个地址必须同源；业务参数按**原字节**保留（顺序、百分号编码、重复参数），
 * 因为签名输入就是去码地址本身。sharecode 永远由这里追加——调用方不得自己拼，
 * 也绝不把它写进日志、错误或展示面。
 */

export const WORKBUDDY_SHARE_PARAMETER = "sharecode";

export class WorkbuddyAddressError extends Error {
  readonly code:
    | "INVALID_SIGN_URL"
    | "NOT_HTTPS"
    | "USERINFO"
    | "FRAGMENT"
    | "EXISTING_SHARE_PARAMETER"
    | "ORIGIN_MISMATCH";

  constructor(code: WorkbuddyAddressError["code"], message: string) {
    super(message);
    this.name = "WorkbuddyAddressError";
    this.code = code;
  }
}

export interface WorkbuddyDualAddress {
  /** 参与签名的地址：不带分享参数，业务参数原样。 */
  readonly signUrl: string;
  /** 实际发送的地址：与 signUrl 仅差末尾追加的分享参数。 */
  readonly sendUrl: string;
}

/**
 * 由业务地址与分享码构造双地址。
 *
 * `signUrl` 必须是**已经确定好**的发送目标（含业务参数）；本函数只做两件事：
 * 校验形状、在末尾追加分享参数（原 query 字节不变）。
 */
export function buildWorkbuddyDualAddress(signUrl: string, secret: string): WorkbuddyDualAddress {
  const raw = String(signUrl ?? "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WorkbuddyAddressError("INVALID_SIGN_URL", "签名地址不是合法 URL");
  }
  if (parsed.protocol !== "https:") {
    throw new WorkbuddyAddressError("NOT_HTTPS", "签名地址必须是 https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new WorkbuddyAddressError("USERINFO", "签名地址不能携带 userinfo");
  }
  if (parsed.hash !== "") {
    throw new WorkbuddyAddressError("FRAGMENT", "签名地址不能携带 fragment");
  }
  const code = String(secret ?? "");
  if (code.trim() === "") {
    throw new WorkbuddyAddressError("INVALID_SIGN_URL", "分享码为空");
  }
  // 现有 sharecode 一律拒绝：不覆盖、不猜测（契约 §2.5.3）。
  for (const [name] of parsed.searchParams) {
    if (name === WORKBUDDY_SHARE_PARAMETER) {
      throw new WorkbuddyAddressError(
        "EXISTING_SHARE_PARAMETER",
        "业务地址已经带有 sharecode 参数",
      );
    }
  }
  // 用原始 query 字节追加：URL 对象会把既有参数重新编码，签名输入必须逐字保持。
  // fragment 已在上方拒绝，所以 raw 就是"可发送基址"。
  const trimmed = raw.endsWith("&") ? raw.slice(0, -1) : raw;
  const separator = parsed.search === "" ? "?" : "&";
  const sendUrl = `${trimmed}${separator}${WORKBUDDY_SHARE_PARAMETER}=${encodeURIComponent(code)}`;
  let sendOrigin: string;
  try {
    sendOrigin = new URL(sendUrl).origin;
  } catch {
    throw new WorkbuddyAddressError("INVALID_SIGN_URL", "无法构造发送地址");
  }
  if (sendOrigin !== parsed.origin) {
    throw new WorkbuddyAddressError("ORIGIN_MISMATCH", "发送地址与签名地址不同源");
  }
  return { signUrl: raw, sendUrl };
}
