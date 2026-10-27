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
 * WorkBuddy 平台行为回显探针（I-01 的服务端一半）。
 *
 * 把本模块起成一个小服务、作为 WorkBuddy 网站应用发布，再从外部按不同方式
 * 调用，就能**自己**量出平台网关到底做了什么：分享参数是否被剥除、其它查询
 * 参数是否保留/重排/重编码、`Authorization` 是否被改写或注入、签名头是否原样
 * 透传。这样 P0-01 里"网关如何改写入站请求"的部分不必等平台答复。
 *
 * 安全设计（这个端点对公网开放）：
 *   - **不回显任何请求头的值**。只报名称、是否存在、以及值的 sha256 前缀；
 *     `authorization` 另报认证方案名（Bearer/Basic/…）与前缀，不报令牌。
 *   - `sharecode` 只报"存在 + 长度"，不回显值。
 *   - 请求体只报长度与 sha256，不回显内容。
 *   - 请求体大小有上限；除 GET/POST/HEAD 外的方法返回 405。
 */

import { createHash } from "node:crypto";

export const ECHO_PATH = "/__probe/echo";
export const HEALTH_PATH = "/__probe/health";
export const MAX_BODY_BYTES = 64 * 1024;

export interface ProbeSummaryInput {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  receivedAt: string;
}

export interface ProbeSummary {
  method: string;
  /** 平台转发到源站时所见路径（用于判断网关是否改写路径）。 */
  path: string;
  /** 查询参数名列表，按到达顺序（判断顺序/重复是否保留）。 */
  query_names: string[];
  /** 原始 query 串（分享参数值以占位符替换，其余原样）。 */
  raw_query: string;
  sharecode: { present: boolean; length: number };
  headers: Array<{
    name: string;
    /** 多值头按到达顺序给出值摘要。 */
    values_sha256: string[];
    /** 仅 `authorization` 给出：认证方案名（值本身永不出现）。 */
    scheme?: string;
  }>;
  body: { length: number; sha256: string };
  received_at: string;
}

function digestShort(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

function headerValues(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

/**
 * 把一次入站请求压成**可公开**的摘要。纯函数，便于单测；调用方负责提供
 * 已解析的 URL 与已读满的请求体。
 */
export function summarizeProbeRequest(input: ProbeSummaryInput): ProbeSummary {
  const url = new URL(input.url, "http://probe.internal");
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const pairs = [...url.searchParams];
  const sharecodes = url.searchParams.getAll("sharecode");
  // 原始串按字节保留（用于判断平台是否重排/重编码业务参数），只把分享参数
  // 的值替换掉——包括重复参数与畸形编码片段，避免任何泄漏。
  const safeRawQuery = rawQuery.replace(
    /(^|&)sharecode=[^&]*/g,
    (_match, separator: string) => `${separator}sharecode=<redacted>`,
  );
  const headers = Object.entries(input.headers)
    .filter(([name]) => name !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, raw]) => {
      const values = headerValues(raw);
      const entry: ProbeSummary["headers"][number] = {
        name: name.toLowerCase(),
        values_sha256: values.map(digestShort),
      };
      if (name.toLowerCase() === "authorization") {
        // 只保留认证方案名（Bearer / Basic / …），令牌本身不进摘要。
        const scheme = /^\s*([A-Za-z][A-Za-z0-9-]{0,15})(\s|$)/.exec(values[0] ?? "")?.[1];
        if (scheme !== undefined) entry.scheme = scheme;
      }
      return entry;
    });
  return {
    method: input.method,
    path: url.pathname,
    query_names: pairs.map(([name]) => name),
    raw_query: safeRawQuery,
    sharecode: { present: sharecodes.length > 0, length: sharecodes[0]?.length ?? 0 },
    headers,
    body: {
      length: input.body.length,
      sha256: `sha256:${createHash("sha256").update(input.body).digest("hex")}`,
    },
    received_at: input.receivedAt,
  };
}

/** 供脚本与测试使用的极简请求处理器（不引入任何依赖）。 */
export function createProbeHandler(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return (request: {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    on(event: "end", listener: () => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  }) => {
    return new Promise<{ status: number; body: unknown }>((resolve) => {
      const method = (request.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "POST" && method !== "HEAD") {
        resolve({ status: 405, body: { error: "method_not_allowed", allow: "GET, POST, HEAD" } });
        return;
      }
      const url = request.url ?? "/";
      if (url.split("?")[0] === HEALTH_PATH) {
        resolve({ status: 200, body: { ok: true } });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          return;
        }
        chunks.push(chunk);
      });
      request.on("error", () => resolve({ status: 400, body: { error: "read_failed" } }));
      request.on("end", () => {
        if (tooLarge) {
          resolve({ status: 413, body: { error: "body_too_large", limit: MAX_BODY_BYTES } });
          return;
        }
        resolve({
          status: 200,
          body: summarizeProbeRequest({
            method,
            url,
            headers: request.headers,
            body: Buffer.concat(chunks),
            receivedAt: now().toISOString(),
          }),
        });
      });
    });
  };
}
