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
 * RFC 9421 HTTP Message Signatures — signature-base 构造与 Signature-Input 解析。
 *
 * 覆盖组件（covered components）为请求上的可签名元素：派生组件（@method /
 * @target-uri / @authority / @scheme / @path / @query）与 HTTP 字段名
 * （小写，如 content-digest）。签名方按声明顺序把每个组件渲染成一行，最后追加
 * `"@signature-params"` 行（组件列表 + 参数字典），每行以 \n 结尾 —— 这就是
 * signature base（RFC 9421 §2.1）。
 *
 * 本模块只做纯函数变换：不接触密钥、不接触时钟。密钥与验签在 message-signature.ts；
 * 重放窗口/策略在 trust-policy.ts / auth-verifier.ts。
 */

/** 覆盖组件：派生组件 @xxx，或小写 HTTP 字段名。 */
export type CoveredComponent =
  | "@method"
  | "@target-uri"
  | "@authority"
  | "@scheme"
  | "@path"
  | "@query"
  | (string & {});

/** @signature-params 参数字典（RFC 9421 §2.2）。 */
export interface SignatureParams {
  /** 整数 unix 秒；签名创建时间。 */
  created?: number;
  /** 整数 unix 秒；签名过期时间（可选）。 */
  expires?: number;
  /** 防重放 nonce（可选）。 */
  nonce?: string;
  /** 签名者 keyid。 */
  keyid?: string;
  /** RFC 9421 alg 名（ed25519 / ecdsa-p256-sha256）。 */
  algorithm?: string;
  /** 应用层 tag（可选，本实现透传）。 */
  tag?: string;
}

export interface ParsedSignatureInput {
  /** 签名标签（如 sig1）。 */
  label: string;
  /** 覆盖组件（按声明顺序）。 */
  components: string[];
  params: SignatureParams;
}

export interface SignatureBaseInput {
  method: string;
  /** 绝对 target URI（或 origin-form 请求目标）。 */
  targetUri: string;
  /** @authority 值（Host 头）。 */
  authority: string;
  /** 请求头（小写名）。 */
  headers: Record<string, string | string[] | undefined>;
  /** 覆盖组件（按声明顺序）。 */
  components: string[];
  params: SignatureParams;
}

/** signature-base 构造/解析失败。 */
export class SignatureBaseError extends Error {
  readonly code: "malformed" | "missing_component";
  constructor(code: SignatureBaseError["code"], message: string) {
    super(message);
    this.name = "SignatureBaseError";
    this.code = code;
  }
}

/** 取单值 HTTP 字段；多值时按 RFC 9421 §2.1 用 ", " 连接。 */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((v) => v.trim()).join(", ");
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** 引号字符串转义（RFC 9421 字典字符串值）。 */
function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 引号字符串反转义。 */
function unescapeString(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

/** 参数字典序列化：RFC 9421 §2.2 固定顺序 created, expires, nonce, keyid, alg, tag。 */
export function serializeParams(params: SignatureParams): string {
  let out = "";
  if (params.created !== undefined) out += `;created=${params.created}`;
  if (params.expires !== undefined) out += `;expires=${params.expires}`;
  if (params.nonce !== undefined) out += `;nonce="${escapeString(params.nonce)}"`;
  if (params.keyid !== undefined) out += `;keyid="${escapeString(params.keyid)}"`;
  if (params.algorithm !== undefined) out += `;alg="${escapeString(params.algorithm)}"`;
  if (params.tag !== undefined) out += `;tag="${escapeString(params.tag)}"`;
  return out;
}

/** 格式化一条 Signature-Input 项：`label=(comps)params`。 */
export function formatSignatureInput(
  label: string,
  components: string[],
  params: SignatureParams,
): string {
  const comps = components.map((c) => `"${c}"`).join(" ");
  return `${label}=(${comps})${serializeParams(params)}`;
}

/** 解析单条 Signature-Input 项。 */
function parseEntry(entry: string): ParsedSignatureInput {
  const eq = entry.indexOf("=");
  if (eq <= 0) {
    throw new SignatureBaseError("malformed", `signature-input entry has no label: "${entry}"`);
  }
  const label = entry.slice(0, eq).trim();
  const rest = entry.slice(eq + 1).trim();
  if (!rest.startsWith("(")) {
    throw new SignatureBaseError("malformed", `signature-input entry "${label}" has no component list`);
  }
  let depth = 0;
  let close = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) {
    throw new SignatureBaseError("malformed", `signature-input entry "${label}" has unterminated component list`);
  }
  const inner = rest.slice(1, close);
  const components = inner
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((s) => {
      const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
      if (m === null) {
        throw new SignatureBaseError("malformed", `signature-input component "${s}" is not a quoted string`);
      }
      return unescapeString(m[1] ?? "");
    });

  const paramsText = rest.slice(close + 1);
  const params: SignatureParams = {};
  for (const param of paramsText.split(";")) {
    const trimmed = param.trim();
    if (trimmed.length === 0) continue;
    const kv = trimmed.indexOf("=");
    if (kv < 0) {
      throw new SignatureBaseError("malformed", `signature-input parameter "${trimmed}" has no value`);
    }
    const key = trimmed.slice(0, kv).trim();
    const rawValue = trimmed.slice(kv + 1).trim();
    switch (key) {
      case "created":
      case "expires": {
        const n = Number(rawValue);
        if (!Number.isInteger(n) || n < 0) {
          throw new SignatureBaseError("malformed", `signature-input ${key} must be a non-negative integer`);
        }
        params[key] = n;
        break;
      }
      case "nonce":
      case "keyid":
      case "alg":
      case "tag": {
        const m = /^"((?:[^"\\]|\\.)*)"$/.exec(rawValue);
        if (m === null) {
          throw new SignatureBaseError("malformed", `signature-input ${key} must be a quoted string`);
        }
        const value = unescapeString(m[1] ?? "");
        // Signature-Input 里是 alg；内部参数名是 algorithm（与 RFC 术语区分）。
        if (key === "alg") params.algorithm = value;
        else params[key] = value;
        break;
      }
      default:
        // 未知参数 RFC 9421 要求拒绝（fail-closed）：签名者/验证者对参数理解不同。
        throw new SignatureBaseError("malformed", `signature-input has unsupported parameter "${key}"`);
    }
  }
  return { label, components, params };
}

/** 按顶层逗号切分（不在括号/引号内的逗号），支持一条头含多个签名。 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== "\\") inQuote = !inQuote;
    if (inQuote) continue;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/** 解析 Signature-Input 头，返回全部签名项（可能多个）。 */
export function parseSignatureInput(value: string): ParsedSignatureInput[] {
  const entries: ParsedSignatureInput[] = [];
  for (const part of splitTopLevel(value)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    entries.push(parseEntry(trimmed));
  }
  return entries;
}

/** 解析 Signature 头：`label=:base64:` 序列。 */
export function parseSignatureHeader(value: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const part of value.trim().split(/\s+/)) {
    const m = /^([A-Za-z0-9_!#$%&'*+\-.^`|~]+)=:([^:]*):$/.exec(part);
    if (m === null) continue;
    out[m[1] ?? ""] = Buffer.from(m[2] ?? "", "base64");
  }
  return out;
}

/**
 * 构造 signature base（RFC 9421 §2.1）。
 * 每个覆盖组件渲染一行（`"name": value`），最后追加 `"@signature-params"` 行。
 * 覆盖的字段缺失时抛 SignatureBaseError（fail-closed：不能对不存在的组件签名）。
 */
export function buildSignatureBase(input: SignatureBaseInput): string {
  const { method, targetUri, authority, headers, components, params } = input;
  let base = "";
  for (const component of components) {
    switch (component) {
      case "@method":
        base += `"@method": ${method}\n`;
        break;
      case "@target-uri":
        base += `"@target-uri": ${targetUri}\n`;
        break;
      case "@authority":
        base += `"@authority": ${authority}\n`;
        break;
      case "@scheme": {
        let scheme: string;
        try {
          scheme = new URL(targetUri).protocol.replace(/:$/, "");
        } catch {
          throw new SignatureBaseError("malformed", `@scheme requires a parseable target URI`);
        }
        base += `"@scheme": ${scheme}\n`;
        break;
      }
      case "@path": {
        let path: string;
        try {
          path = new URL(targetUri).pathname;
        } catch {
          throw new SignatureBaseError("malformed", `@path requires a parseable target URI`);
        }
        base += `"@path": ${path}\n`;
        break;
      }
      case "@query": {
        let query: string;
        try {
          query = new URL(targetUri).search.replace(/^\?/, "");
        } catch {
          throw new SignatureBaseError("malformed", `@query requires a parseable target URI`);
        }
        base += `"@query": ${query}\n`;
        break;
      }
      default: {
        const value = headerValue(headers, component);
        if (value === undefined) {
          throw new SignatureBaseError(
            "missing_component",
            `covered component "${component}" is not present in the request`,
          );
        }
        base += `"${component}": ${value}\n`;
        break;
      }
    }
  }
  const comps = components.map((c) => `"${c}"`).join(" ");
  base += `"@signature-params": (${comps})${serializeParams(params)}\n`;
  return base;
}
