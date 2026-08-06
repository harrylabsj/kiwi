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
 * A2A 出站端点 URL 安全策略（SSRF 防护）。
 *
 * 对齐仓库既有 base_url 安全做法（src/config/profile.ts assertSecureBaseUrl）：
 * 只打 http(s)、禁止 userinfo、明文 HTTP 仅限 loopback 主机。在此基础上为
 * 出站（访问远端 untrusted Agent Card 端点）增加私网/保留网段拒绝：
 *
 * - 字面 IP 落在 RFC1918 私网、link-local、CGNAT、保留段、multicast、loopback
 *   之外才放行（loopback 默认放行，与仓库模式一致）；
 * - 主机名先做保留主机名检查，再在请求前 DNS 解析复查解析出的 IP（DNS
 *   rebinding 的基础缓解；`allowPrivateRanges` 可显式逃生）。
 *
 * 任何拒绝都抛 A2AClientError("unsafe_target")，fail-closed。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { A2AClientError } from "./error.js";

export interface SafeTargetUrlOptions {
  /** 允许私网/保留网段（默认 false）。loopback 始终允许。 */
  allowPrivateRanges?: boolean;
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const RESERVED_HOSTNAMES: ReadonlySet<string> = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data.ec2.internal",
  "ip-169-254-169-254.ec2.internal",
]);

function isIpLiteral(hostname: string): boolean {
  return isIP(stripBrackets(hostname)) !== 0;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

// ---------------------------------------------------------------------------
// IPv4 范围判定
// ---------------------------------------------------------------------------

interface IpRange {
  start: number;
  end: number;
  name: string;
}

const IPV4_RANGES: readonly IpRange[] = [
  { start: 0x00000000, end: 0x00ffffff, name: "this network 0.0.0.0/8" },
  { start: 0x0a000000, end: 0x0affffff, name: "private 10.0.0.0/8" },
  { start: 0x64400000, end: 0x647fffff, name: "CGNAT 100.64.0.0/10" },
  { start: 0x7f000000, end: 0x7fffffff, name: "loopback 127.0.0.0/8" },
  { start: 0xa9fe0000, end: 0xa9feffff, name: "link-local 169.254.0.0/16" },
  { start: 0xac100000, end: 0xac1fffff, name: "private 172.16.0.0/12" },
  { start: 0xc0000000, end: 0xc00000ff, name: "IETF protocol 192.0.0.0/24" },
  { start: 0xc0000200, end: 0xc00002ff, name: "TEST-NET-1 192.0.2.0/24" },
  { start: 0xc0a80000, end: 0xc0a8ffff, name: "private 192.168.0.0/16" },
  { start: 0xc6120000, end: 0xc633ffff, name: "benchmarking 198.18.0.0/15" },
  { start: 0xc6336400, end: 0xc63364ff, name: "TEST-NET-2 198.51.100.0/24" },
  { start: 0xcb007100, end: 0xcb0071ff, name: "TEST-NET-3 203.0.113.0/24" },
  { start: 0xe0000000, end: 0xefffffff, name: "multicast 224.0.0.0/4" },
  { start: 0xf0000000, end: 0xffffffff, name: "reserved 240.0.0.0/4" },
];

export function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return undefined;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

export function isReservedIpv4(ip: string): { reserved: boolean; name?: string } {
  const value = ipv4ToInt(ip);
  if (value === undefined) return { reserved: false };
  const hit = IPV4_RANGES.find((range) => value >= range.start && value <= range.end);
  return hit !== undefined ? { reserved: true, name: hit.name } : { reserved: false };
}

// ---------------------------------------------------------------------------
// IPv6 范围判定
// ---------------------------------------------------------------------------

function normalizeIpv6(ip: string): string | undefined {
  const clean = stripBrackets(ip);
  if (isIP(clean) !== 6) return undefined;
  const address = clean.toLowerCase();
  const [head, tail] = address.split("::");
  if (head === undefined) return undefined;
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 0) return undefined;
  const all = [...headGroups, ...new Array<string>(fill).fill("0"), ...tailGroups];
  return all.map((group) => group.padStart(4, "0")).join(":");
}

const IPV6_LOOPBACK = "0000:0000:0000:0000:0000:0000:0000:0001";
const IPV6_UNSPECIFIED = "0000:0000:0000:0000:0000:0000:0000:0000";
const IPV6_V4MAPPED_PREFIX = "0000:0000:0000:0000:0000:ffff:";

export function isReservedIpv6(ip: string): { reserved: boolean; name?: string } {
  const normalized = normalizeIpv6(ip);
  if (normalized === undefined) return { reserved: false };
  if (normalized === IPV6_LOOPBACK) return { reserved: true, name: "loopback ::1/128" };
  if (normalized === IPV6_UNSPECIFIED) return { reserved: true, name: "unspecified ::/128" };
  // IPv4-mapped IPv6 按内嵌 IPv4 判定（::ffff:127.0.0.1 等）。
  if (normalized.startsWith(IPV6_V4MAPPED_PREFIX)) {
    const groups = normalized.slice(IPV6_V4MAPPED_PREFIX.length).split(":");
    const last = groups[groups.length - 1];
    const penultimate = groups[groups.length - 2];
    if (last !== undefined && penultimate !== undefined) {
      const a = Number.parseInt(penultimate, 16);
      const b = Number.parseInt(last, 16);
      const mapped = `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
      const ipv4 = isReservedIpv4(mapped);
      if (ipv4.reserved) return { reserved: true, name: `IPv4-mapped ${ipv4.name}` };
    }
    return { reserved: false };
  }
  const first = normalized.slice(0, 4);
  // fc00::/7 覆盖 fc00-fdff 首 hextet。
  if (first.startsWith("fc") || first.startsWith("fd"))
    return { reserved: true, name: "unique local fc00::/7" };
  if (first.startsWith("fe8")) return { reserved: true, name: "link-local fe80::/10" };
  if (first.startsWith("ff")) return { reserved: true, name: "multicast ff00::/8" };
  if (normalized.startsWith("2001:0db8"))
    return { reserved: true, name: "documentation 2001:db8::/32" };
  return { reserved: false };
}

// ---------------------------------------------------------------------------
// 主机判定
// ---------------------------------------------------------------------------

/** loopback 主机：known hostname 或 loopback 范围字面 IP。 */
export function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(lower)) return true;
  const ip = stripBrackets(lower);
  if (isIP(ip) === 4) {
    const value = ipv4ToInt(ip);
    return value !== undefined && value >= 0x7f000000 && value <= 0x7fffffff;
  }
  if (isIP(ip) === 6) {
    return normalizeIpv6(ip) === IPV6_LOOPBACK;
  }
  return false;
}

function isReservedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (RESERVED_HOSTNAMES.has(lower)) return true;
  // RFC 6762/6761 保留域：云元数据主机常落在 *.internal。
  return lower.endsWith(".internal");
}

function unsafeTarget(message: string): A2AClientError {
  return new A2AClientError("unsafe_target", message);
}

/**
 * 静态 URL 安全校验（同步）。构造 client / 选中 binding 时执行。
 * 返回规范化 URL；拒绝时抛 unsafe_target。
 */
export function assertSafeTargetUrl(value: string, options: SafeTargetUrlOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unsafeTarget(`invalid URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw unsafeTarget(`A2A endpoint must use http or https (got ${url.protocol})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw unsafeTarget("A2A endpoint must not embed credentials (userinfo)");
  }
  const hostname = url.hostname;
  const loopback = isLoopbackHost(hostname);
  if (url.protocol === "http:") {
    if (!loopback) {
      throw unsafeTarget(
        "cleartext HTTP only for loopback hosts (localhost, 127.0.0.1, ::1) — use HTTPS for remote endpoints",
      );
    }
  }
  if (loopback) return url;

  if (isIpLiteral(hostname)) {
    const ip = stripBrackets(hostname);
    const check = isIP(ip) === 4 ? isReservedIpv4(ip) : isReservedIpv6(ip);
    if (check.reserved && !options.allowPrivateRanges) {
      throw unsafeTarget(`A2A endpoint resolves to a reserved network (${check.name})`);
    }
  } else if (isReservedHostname(hostname) && !options.allowPrivateRanges) {
    throw unsafeTarget(`A2A endpoint hostname is reserved (${hostname})`);
  }
  return url;
}

export interface ResolvableTargetUrlOptions extends SafeTargetUrlOptions {
  skipDnsCheck?: boolean;
  resolveIp?: (hostname: string) => Promise<string[]>;
}

/**
 * 请求前的 DNS 复查：主机名解析出的每个 IP 都必须通过私网/保留网段判定。
 * 字面 IP 跳过（静态校验已覆盖）；解析失败 fail-closed。
 */
export async function assertResolvableTargetUrl(
  url: URL,
  options: ResolvableTargetUrlOptions = {},
): Promise<void> {
  const hostname = url.hostname;
  if (options.skipDnsCheck) return;
  if (isIpLiteral(hostname) || isLoopbackHost(hostname)) return;

  const resolve =
    options.resolveIp ??
    ((h: string) =>
      lookup(h, { all: true, verbatim: true }).then((addrs) => addrs.map((a) => a.address)));

  let ips: string[];
  try {
    ips = await resolve(hostname);
  } catch {
    throw unsafeTarget(`cannot resolve A2A endpoint host ${hostname}`);
  }
  for (const ip of ips) {
    const version = isIP(ip);
    const check =
      version === 4 ? isReservedIpv4(ip) : version === 6 ? isReservedIpv6(ip) : { reserved: false };
    // loopback 解析结果始终放行（与静态校验一致）；其余保留网段拒绝。
    if (check.reserved && !isLoopbackHost(ip) && !options.allowPrivateRanges) {
      throw unsafeTarget(
        `A2A endpoint host ${hostname} resolves to a reserved network (${check.name})`,
      );
    }
  }
}
