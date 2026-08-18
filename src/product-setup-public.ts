/*
 * Copyright 2026 Harrylabs
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
 * `kiwi merchant setup-public`（产品层 D3）——公网 A2A 暴露引导。
 *
 * well-known 文件（`/.well-known/agent-card.json`、`/.well-known/ucp`）由跑着的
 * `kiwi merchant start` 节点自动生成并服务（a2a/server），商家无需手写。本模块把
 * 「域名 → A2A endpoint」这一步变成引导向导：检测本机公网 IP、检查域名 DNS、生成
 * Caddy 反代配置、输出启动与验证命令。
 *
 * 幂等：只生成配置 + 打印指引 + 可选 `--check` 验证，不改 profile/DB。
 */
import { promises as dnsPromises } from "node:dns";
import { writeFile } from "node:fs/promises";

const DEFAULT_IP_SERVICE = "https://api.ipify.org";
const DEFAULT_WELL_KNOWN_PATH = "/.well-known/agent-card.json";

/** setup-public 类型化错误（fail-closed）。 */
export class SetupPublicError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SetupPublicError";
    this.code = code;
  }
}

/** 从 `KIWI_A2A_PUBLIC_URL`（https://<domain>）提取公网域名；无效返回 null。 */
export function extractPublicDomain(publicUrl: string | undefined): string | null {
  if (publicUrl === undefined || publicUrl.trim() === "") return null;
  try {
    const u = new URL(publicUrl.trim());
    if (u.protocol !== "https:") return null;
    if (u.username !== "" || u.password !== "") return null;
    if (u.pathname !== "/" && u.pathname !== "") return null;
    if (u.search !== "" || u.hash !== "") return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 校验并归一化公网域名（无 scheme/path/port/userinfo）。 */
export function validatePublicDomain(domain: string): string {
  const raw = String(domain ?? "").trim().toLowerCase();
  if (raw === "") {
    throw new SetupPublicError("domain_required", "请提供公网域名（如 merchant.example.com）");
  }
  if (raw.includes("://")) {
    throw new SetupPublicError("domain_scheme", "域名不应含 scheme（只需 merchant.example.com）");
  }
  if (raw.includes("/")) {
    throw new SetupPublicError("domain_path", "域名不应含路径");
  }
  if (raw.includes(":") || raw.includes("@") || raw.includes("?") || raw.includes("#")) {
    throw new SetupPublicError("domain_invalid", `域名含非法字符（: @ ? #）: "${raw}"`);
  }
  if (!/^[a-z0-9.-]+$/.test(raw)) {
    throw new SetupPublicError("domain_invalid", `域名含非法字符: "${raw}"`);
  }
  if (!raw.includes(".")) {
    throw new SetupPublicError("domain_tld", `域名缺少点（应形如 merchant.example.com）: "${raw}"`);
  }
  return raw;
}

/** 生成 Caddy 反代配置（把 `<domain>` 转发到本机 A2A 节点）。 */
export function buildCaddyfile(domain: string, port: number): string {
  const safePort = Number.isInteger(port) && port > 0 ? port : 9000;
  return `${domain} {
    reverse_proxy 127.0.0.1:${safePort}
}`;
}

/** 检测本机公网 IP；不可达/失败返回 null（降级为手动确认，不 crash）。 */
export async function detectPublicIp(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(DEFAULT_IP_SERVICE, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

export interface DnsCheckResult {
  status: "ok" | "mismatch" | "unresolved" | "skipped";
  resolved: string | null;
  expected: string | null;
}

/** 解析域名 A 记录并对比期望 IP（服务器公网 IP）。 */
export async function checkDomainDns(
  domain: string,
  expectedIp: string | null,
  lookupImpl: (hostname: string) => Promise<string | null> = async (hostname) => {
    try {
      const { address } = await dnsPromises.lookup(hostname, { family: 4 });
      return address;
    } catch {
      return null;
    }
  },
): Promise<DnsCheckResult> {
  const resolved = await lookupImpl(domain);
  if (resolved === null) {
    return { status: "unresolved", resolved: null, expected: expectedIp };
  }
  if (expectedIp === null) {
    return { status: "skipped", resolved, expected: null };
  }
  return resolved === expectedIp
    ? { status: "ok", resolved, expected: expectedIp }
    : { status: "mismatch", resolved, expected: expectedIp };
}

export interface WellKnownCheck {
  url: string;
  httpStatus: number | null;
}

/** `--check`：验证 `https://<domain>/.well-known/agent-card.json` 可达。 */
export async function verifyWellKnown(
  domain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WellKnownCheck> {
  const url = `https://${domain}${DEFAULT_WELL_KNOWN_PATH}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    return { url, httpStatus: res.status };
  } catch {
    return { url, httpStatus: null };
  }
}

export interface SetupPublicOptions {
  domain: string;
  port: number;
  caddyfilePath: string;
  merchantAgentId: string;
  profilePath?: string;
  checkNow?: boolean;
  publicIpOverride?: string | null;
  fetchImpl?: typeof fetch;
  lookupImpl?: (hostname: string) => Promise<string | null>;
  writeFileImpl?: (path: string, content: string) => Promise<void>;
}

export interface SetupPublicReport {
  merchantAgentId: string;
  domain: string;
  port: number;
  publicIp: string | null;
  dns: DnsCheckResult;
  caddyfilePath: string;
  caddyfile: string;
  check: WellKnownCheck | null;
  instructions: string[];
}

/** 编排 setup-public：检测 IP → DNS 检查 → 生成/写 Caddyfile → 可选验证。 */
export async function runMerchantSetupPublic(opts: SetupPublicOptions): Promise<SetupPublicReport> {
  const publicIp =
    opts.publicIpOverride !== undefined ? opts.publicIpOverride : await detectPublicIp(opts.fetchImpl);
  const dns = await checkDomainDns(opts.domain, publicIp, opts.lookupImpl);
  const caddyfile = `${buildCaddyfile(opts.domain, opts.port)}\n`;
  const writeImpl = opts.writeFileImpl ?? writeFile;
  await writeImpl(opts.caddyfilePath, caddyfile);
  const check = opts.checkNow === true ? await verifyWellKnown(opts.domain, opts.fetchImpl) : null;

  const profileFlag = opts.profilePath !== undefined && opts.profilePath !== "" ? ` --profile ${opts.profilePath}` : "";
  const instructions = [
    `1) 安装并启动 Caddy（TLS 自动签发）：`,
    `   caddy run --config ${opts.caddyfilePath}`,
    ``,
    `2) 启动 A2A 节点（广告公网地址，well-known 由节点自动生成）：`,
    `   KIWI_A2A_PUBLIC_URL=https://${opts.domain} kiwi merchant start${profileFlag} --port ${opts.port} &`,
    ``,
    `3) 验证 well-known（期望 200）：`,
    `   curl -sI https://${opts.domain}${DEFAULT_WELL_KNOWN_PATH}`,
  ];

  return {
    merchantAgentId: opts.merchantAgentId,
    domain: opts.domain,
    port: opts.port,
    publicIp,
    dns,
    caddyfilePath: opts.caddyfilePath,
    caddyfile,
    check,
    instructions,
  };
}
