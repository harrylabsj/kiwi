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
 * 平台网关访问 cookie 的最小 jar（WorkBuddy sharecode 通道）。
 *
 * 平台口径（2026-10-28 工单回复）：分享码等价于访问凭据，**首次带码访问后网关
 * 下发 cookie（30 天、host-only），后续子资源可免带码**；分享码本身面向人工
 * 分享，不适合大规模机器分发。所以买家必须复用这个 cookie——只在冷启动/轮换后
 * 带一次码，而不是每个 A2A 请求都带，既降低风控面也少一次跳转。
 *
 * 纪律：
 * - 只按 **origin** 存（等价 host-only，绝不发给别的域）；
 * - 只存 `name=value`，不解析也不使用其它属性做安全判断；
 * - 有 `Max-Age`/`Expires` 就按它过期，没有就按调用方给的默认 TTL（默认 30 天，
 *   与平台一致）；
 * - 内存态：买家进程重启后重新带一次码拿新 cookie，不做跨进程持久化（少一处
 *   凭据落盘面）。
 */

export const DEFAULT_GATEWAY_COOKIE_TTL_MS = 30 * 24 * 3_600_000;

export interface GatewayCookieEntry {
  value: string;
  expiresAt: number;
}

function expiryOf(attributes: string[], now: number): number {
  for (const raw of attributes) {
    const [name, ...rest] = raw.split("=");
    const key = (name ?? "").trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "max-age") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
    }
    if (key === "expires") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return now + DEFAULT_GATEWAY_COOKIE_TTL_MS;
}

export class GatewayCookieJar {
  private readonly byOrigin = new Map<string, GatewayCookieEntry>();

  /** 该 origin 当前可用的 Cookie 头值；过期即删。 */
  get(origin: string, now: number = Date.now()): string | undefined {
    const entry = this.byOrigin.get(origin);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.byOrigin.delete(origin);
      return undefined;
    }
    return entry.value;
  }

  has(origin: string, now: number = Date.now()): boolean {
    return this.get(origin, now) !== undefined;
  }

  /** 解析一组 Set-Cookie；只保留 name=value，并记录过期时间。 */
  capture(origin: string, setCookie: readonly string[], now: number = Date.now()): void {
    for (const header of setCookie) {
      const parts = header.split(";");
      const pair = (parts[0] ?? "").trim();
      if (pair === "" || !pair.includes("=")) continue;
      const expiresAt = expiryOf(parts.slice(1), now);
      if (expiresAt <= now) continue;
      // 同名覆盖：网关轮换后旧值必须失效，这里以最后一条为准。
      this.byOrigin.set(origin, { value: pair, expiresAt });
    }
  }

  clear(origin: string): void {
    this.byOrigin.delete(origin);
  }

  clearAll(): void {
    this.byOrigin.clear();
  }
}
