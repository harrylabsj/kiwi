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
 * 出站 HTTP 客户端共享安全原语（出站侧加固评审项统一实施）。
 *
 * 仓库所有出站 fetch 客户端（A2A client / Agent Card / UCP profile / catalog /
 * shopping-cli / commerce API）统一三条纪律：
 *
 * 1. **redirect: "manual"**：绝不跟随 3xx——重定向目标不经过 SSRF/DNS 复查，
 *    且重定向可能把 Authorization 头转发给第三方（resolve/ucp 此前已实施，
 *    本模块提供统一判定 `isRedirectResponse` 供其余客户端对齐）。
 * 2. **超时覆盖响应体读取**：AbortController 的 timer 必须活到 body 读完——
 *    对端在响应头后停滞 body 是经典的永久挂起手法（此前 timer 在 headers
 *    到达即 clear，body 读不在任何超时保护内）。
 * 3. **响应体大小上限**：Content-Length 预检 + 流式读取计数，超过即中断
 *    （防恶意对端回传 GB 级 body 打爆进程内存）。
 *
 * 错误全部类型化（SafeHttpError + code），调用方 catch 后映射为自己的域错误
 * （fail-closed，不静默容错）。零新增依赖：Node 22 原生 fetch + streams。
 */

/** 响应体上限缺省值（8 MiB；Agent Card/UCP profile 等正常响应远小于此）。 */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type SafeHttpErrorCode = "redirect" | "response_too_large" | "invalid_json";

export class SafeHttpError extends Error {
  readonly code: SafeHttpErrorCode;
  constructor(code: SafeHttpErrorCode, message: string) {
    super(message);
    this.name = "SafeHttpError";
    this.code = code;
  }
}

/** redirect: "manual" 下 3xx / opaqueredirect 的统一拒绝判定。 */
export function isRedirectResponse(response: Response): boolean {
  return (
    response.redirected ||
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  );
}

export interface ReadJsonBodyOptions {
  /** 响应体上限（缺省 DEFAULT_MAX_RESPONSE_BYTES）。 */
  maxBytes?: number;
  /** 请求的 AbortController signal：abort 时中断挂起的 body 读（超时兜底）。 */
  signal?: AbortSignal;
}

/**
 * 流式读取响应体并解析 JSON。Content-Length 预检 + 读取计数超上限即
 * `response_too_large`；signal abort 会 cancel 底层流（挂起的 read 被中断，
 * 由调用方按自己的超时错误路径处理）；JSON 解析失败抛 `invalid_json`。
 */
export async function readJsonBody(response: Response, options: ReadJsonBodyOptions = {}): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const signal = options.signal;

  // Content-Length 预检：声明长度超限直接拒绝，不开始读（快失败）。
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new SafeHttpError(
        "response_too_large",
        `response content-length ${declared} exceeds limit ${maxBytes}`,
      );
    }
  }

  if (response.body === null) {
    throw new SafeHttpError("invalid_json", "response has no body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // signal abort → cancel 底层流：挂起的 reader.read() 被中断（否则慢 body
  // 会永远挂住——timer 只 abort fetch 头阶段，读阶段必须手动取消）。
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new SafeHttpError(
          "response_too_large",
          `response body exceeds limit ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  const text = new TextDecoder().decode(concatChunks(chunks));
  try {
    return JSON.parse(text);
  } catch {
    throw new SafeHttpError("invalid_json", "response body is not valid JSON");
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
