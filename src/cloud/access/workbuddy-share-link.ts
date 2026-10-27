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
 * WorkBuddy 分享链接解析（M-01，G1 契约 §2.1/§3）。
 *
 * 商家粘贴的是平台给的**带码地址**；Kiwi 需要的只是两样东西：
 *   1. 纯 HTTPS origin——它必须与已绑定 runtime_origin 逐字一致（身份地址不放宽）；
 *   2. 分享码——平台门禁参数，随后由 Catalog 受控保存与分发。
 *
 * 解析是严格的：非 HTTPS、userinfo、fragment、非默认端口、缺失或重复
 * `sharecode` 一律拒绝，绝不"尽力解析"。额外的业务参数允许存在（平台可能
 * 附带跟踪参数），但**不参与**访问配置，也不会被带进任何签名材料。
 */

export const WORKBUDDY_PARAMETER_NAME = "sharecode";
export const WORKBUDDY_PROVIDER = "workbuddy";
export const WORKBUDDY_ACCESS_MODE = "share_parameter";
export const WORKBUDDY_ADAPTER_VERSION = "workbuddy-share-v1";
export const WORKBUDDY_AUTH_MODE = "signature";
/** 与 Catalog 侧 `SECRET_MAX_LENGTH` 一致。 */
export const WORKBUDDY_SECRET_MAX_LENGTH = 4096;

export type WorkbuddyShareLinkErrorCode =
  | "MALFORMED_URL"
  | "NOT_HTTPS"
  | "USERINFO"
  | "FRAGMENT"
  | "INVALID_PORT"
  | "MISSING_SHARECODE"
  | "DUPLICATE_SHARECODE"
  | "EMPTY_SHARECODE"
  | "SHARECODE_TOO_LONG"
  | "ORIGIN_MISMATCH";

/** 解析失败：`code` 是稳定的自有错误码，消息可安全展示给商家。 */
export class WorkbuddyShareLinkError extends Error {
  readonly code: WorkbuddyShareLinkErrorCode;

  constructor(code: WorkbuddyShareLinkErrorCode, message: string) {
    super(message);
    this.name = "WorkbuddyShareLinkError";
    this.code = code;
  }
}

export interface WorkbuddyShareLink {
  /** 纯 origin（`https://host[:port]`），无尾斜杠、无路径。 */
  readonly origin: string;
  readonly parameterName: typeof WORKBUDDY_PARAMETER_NAME;
  /** 分享码明文；只允许交给 Catalog 受控提交，绝不写日志/回显。 */
  readonly secretValue: string;
  /** 链接上的其它参数（原样保留，仅用于诊断；不进入访问配置）。 */
  readonly extraParameters: ReadonlyArray<readonly [string, string]>;
}

/** 去掉尾部斜杠；只处理字符串形态，不做规范化推测。 */
export function normalizeRuntimeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * 解析 WorkBuddy 分享链接。失败抛 `WorkbuddyShareLinkError`，不返回部分结果。
 */
export function parseWorkbuddyShareLink(raw: unknown): WorkbuddyShareLink {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") {
    throw new WorkbuddyShareLinkError("MALFORMED_URL", "分享链接不能为空");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new WorkbuddyShareLinkError("MALFORMED_URL", "分享链接不是合法 URL");
  }
  if (url.protocol !== "https:") {
    throw new WorkbuddyShareLinkError("NOT_HTTPS", "分享链接必须是 https 地址");
  }
  if (url.username !== "" || url.password !== "") {
    throw new WorkbuddyShareLinkError("USERINFO", "分享链接不能携带用户名或密码");
  }
  if (url.hash !== "") {
    throw new WorkbuddyShareLinkError("FRAGMENT", "分享链接不能携带 fragment");
  }
  // 只接受默认端口：带显式非 443 端口的地址不是商家已绑定的公网入口。
  if (url.port !== "" && url.port !== "443") {
    throw new WorkbuddyShareLinkError("INVALID_PORT", "分享链接只能使用 https 默认端口");
  }
  const codes = url.searchParams.getAll(WORKBUDDY_PARAMETER_NAME);
  if (codes.length === 0) {
    throw new WorkbuddyShareLinkError("MISSING_SHARECODE", "分享链接缺少 sharecode 参数");
  }
  if (codes.length > 1) {
    throw new WorkbuddyShareLinkError("DUPLICATE_SHARECODE", "分享链接包含多个 sharecode 参数");
  }
  const secret = codes[0] ?? "";
  if (secret.trim() === "") {
    throw new WorkbuddyShareLinkError("EMPTY_SHARECODE", "分享码不能为空");
  }
  if (secret.length > WORKBUDDY_SECRET_MAX_LENGTH) {
    throw new WorkbuddyShareLinkError("SHARECODE_TOO_LONG", "分享码超出长度上限");
  }
  const extraParameters: Array<readonly [string, string]> = [];
  for (const [name, value] of url.searchParams) {
    if (name !== WORKBUDDY_PARAMETER_NAME) extraParameters.push([name, value]);
  }
  return {
    origin: `${url.protocol}//${url.host}`,
    parameterName: WORKBUDDY_PARAMETER_NAME,
    secretValue: secret,
    extraParameters,
  };
}

/**
 * 分享链接的 origin 必须与已绑定 runtime_origin 逐字一致（M-01）。
 *
 * 只做"相等"判定：不做 host 别名、大小写或端口省略的推测——运行时报告的
 * origin 就是身份地址，放宽它就等于允许把码投递给别的部署。
 */
export function assertShareLinkMatchesRuntimeOrigin(
  link: WorkbuddyShareLink,
  runtimeOrigin: string,
): void {
  const expected = normalizeRuntimeOrigin(runtimeOrigin);
  if (expected === "") {
    throw new WorkbuddyShareLinkError("ORIGIN_MISMATCH", "运行时没有可用的公网 origin");
  }
  if (link.origin !== expected) {
    throw new WorkbuddyShareLinkError(
      "ORIGIN_MISMATCH",
      `分享链接指向的不是本实例的公网入口（期望 ${expected}）`,
    );
  }
}

/** 提交给 Catalog 的 `access_config`（首次绑定的 body 字段）。 */
export interface WorkbuddyAccessConfig {
  readonly provider: typeof WORKBUDDY_PROVIDER;
  readonly access_mode: typeof WORKBUDDY_ACCESS_MODE;
  readonly parameter_name: typeof WORKBUDDY_PARAMETER_NAME;
  readonly secret_value: string;
  readonly adapter_version: typeof WORKBUDDY_ADAPTER_VERSION;
  readonly auth_mode: typeof WORKBUDDY_AUTH_MODE;
  readonly expected_version: number;
}

/** 撤销形状：只带模式与当前版本。 */
export interface WorkbuddyAccessRevocation {
  readonly access_mode: "none";
  readonly expected_version: number;
}

/**
 * 由已解析的分享链接构造提交体。`expectedVersion` 是 CAS 头：首次为 0，
 * 更新/撤销为当前 active 版本。
 */
export function buildWorkbuddyAccessConfig(
  link: WorkbuddyShareLink,
  expectedVersion: number,
): WorkbuddyAccessConfig {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new WorkbuddyShareLinkError("MALFORMED_URL", "expected_version 必须是非负整数");
  }
  return {
    provider: WORKBUDDY_PROVIDER,
    access_mode: WORKBUDDY_ACCESS_MODE,
    parameter_name: WORKBUDDY_PARAMETER_NAME,
    secret_value: link.secretValue,
    adapter_version: WORKBUDDY_ADAPTER_VERSION,
    auth_mode: WORKBUDDY_AUTH_MODE,
    expected_version: expectedVersion,
  };
}

export function buildWorkbuddyAccessRevocation(expectedVersion: number): WorkbuddyAccessRevocation {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new WorkbuddyShareLinkError("MALFORMED_URL", "撤销需要当前的配置版本");
  }
  return { access_mode: "none", expected_version: expectedVersion };
}
