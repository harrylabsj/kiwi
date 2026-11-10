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
 * 限流分桶用的客户端地址（审查 P2：反代下不要全体共享一个 socket 桶）。
 *
 * - 默认**不信任** `x-forwarded-for`：直连对端可伪造，只有显式声明
 *   `KIWI_TRUST_PROXY_XFF=1`（或传 options.trustForwardedFor=true）才采信；
 * - 采信时取**最右**合法 IP（代理追加的位置），左侧条目客户端可任意伪造/轮换；
 * - 非法/缺失一律回退到 socket 对端。
 */
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export interface ClientIpOptions {
  /** 显式声明请求来自可信反向代理；缺省读 KIWI_TRUST_PROXY_XFF === "1"。 */
  trustForwardedFor?: boolean;
}

function rightmostForwardedIp(raw: string): string | undefined {
  const parts = raw.split(",").map((part) => part.trim());
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const candidate = parts[index] ?? "";
    if (candidate !== "" && isIP(candidate) !== 0) return candidate;
  }
  return undefined;
}

export function resolveRequestClientIp(
  req: IncomingMessage,
  options: ClientIpOptions = {},
): string | undefined {
  const trust =
    options.trustForwardedFor ?? (process.env.KIWI_TRUST_PROXY_XFF ?? "").trim() === "1";
  if (trust) {
    const header = req.headers["x-forwarded-for"];
    const raw = Array.isArray(header) ? header[0] : header;
    if (typeof raw === "string") {
      const forwarded = rightmostForwardedIp(raw);
      if (forwarded !== undefined) return forwarded;
    }
  }
  return req.socket?.remoteAddress ?? undefined;
}
