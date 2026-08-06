/**
 * UCP Profile 服务化（WP3，基线 §25 / §8.3 / §43）。
 *
 * merchant 侧从 AgentCardConfig 生成 UCP Profile 并在 `GET /.well-known/ucp`
 * 上发布（UCP 规范强制的标准发现入口）：
 *
 *   - a2a service transport：endpoint 指向本 server 的 Agent Card well-known
 *     URL（`<baseUrl>/.well-known/agent-card.json`），基线 §25；
 *   - Kiwi vendor capability：`com.harrylabsj.kiwi.shopping.negotiation`（§8.3，
 *     真实 authority `kiwi.harrylabsj.com`，spec/schema 需托管在该域名上）。
 *
 * 不声明任何 `dev.ucp.*` capability：该 namespace 为 UCP 治理机构保留，vendor
 * 不得占用（`dev.ucp.shopping.*` 官方 capability 仅 checkout / cart / order /
 * fulfillment / discount）；Kiwi 协商能力以 Vendor Root Capability 形态发布（§25.2）。
 *
 * 构建结果强制过 validateUcpProfile 自洽校验（fail-closed：过不了校验就不发）。
 * 响应头 Cache-Control 由 buildUcpProfile 计算（`public, max-age=N`，N>=60）。
 *
 * 零新增依赖。
 */

import { buildKiwiVendorProfile } from "../../discovery/ucp/vendor.js";
import { validateUcpProfile } from "../../discovery/ucp/validate.js";
import { WELL_KNOWN_UCP_PATH } from "../../discovery/ucp/resolver.js";
import type { UcpProfile } from "../../discovery/ucp/types.js";
import type { AgentCardConfig } from "./types.js";

export { WELL_KNOWN_UCP_PATH };

const DEFAULT_WELL_KNOWN_AGENT_CARD_PATH = "/.well-known/agent-card.json";
const DEFAULT_MAX_AGE_SECONDS = 300;
const MIN_MAX_AGE_SECONDS = 60;

/** buildKiwiVendorProfile 透传选项（agentCardUrl 由本模块推导，不在此暴露）。 */
export interface UcpVendorOptions {
  authority?: string;
  version?: string;
  capabilityName?: string;
  serviceName?: string;
  ucpVersion?: string;
}

/** UCP Profile 发布选项（A2AServerOptions.ucp）。 */
export interface UcpPublishOptions {
  /** 是否发布（缺省 true）。 */
  enabled?: boolean;
  /** 本 server 的 Agent Card well-known 路径（默认 /.well-known/agent-card.json）。 */
  wellKnownPath?: string;
  /** Cache-Control max-age 秒（默认 300，必须 >= 60，UCP 规范强制）。 */
  maxAgeSeconds?: number;
  /** buildKiwiVendorProfile 透传选项（authority 等）。 */
  vendor?: UcpVendorOptions;
}

/** buildUcpProfile 的产物：可发布 profile + 计算好的 Cache-Control 头。 */
export interface BuiltUcpProfile {
  profile: UcpProfile;
  cacheControl: string;
  maxAgeSeconds: number;
}

function requireHttpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AgentCardConfig: ${field} must be a valid URL (got "${value}")`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`AgentCardConfig: ${field} must use http or https (got ${url.protocol})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`AgentCardConfig: ${field} must not embed credentials (userinfo)`);
  }
  return url;
}

/**
 * 从本地 Agent Card 配置生成 UCP Profile。构建结果强制过 validateUcpProfile
 * 自洽校验（fail-closed：被拒条目存在即抛错，不发布坏 profile）。
 */
export function buildUcpProfile(
  config: AgentCardConfig,
  opts: UcpPublishOptions = {},
): BuiltUcpProfile {
  const baseUrl = requireHttpUrl(config.baseUrl, "baseUrl");
  const maxAgeSeconds = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < MIN_MAX_AGE_SECONDS) {
    throw new Error(
      `UCP profile Cache-Control max-age must be an integer >= ${MIN_MAX_AGE_SECONDS} (got ${maxAgeSeconds})`,
    );
  }

  const wellKnownPath = opts.wellKnownPath ?? DEFAULT_WELL_KNOWN_AGENT_CARD_PATH;
  const agentCardUrl = new URL(wellKnownPath, baseUrl).href;
  const profile = buildKiwiVendorProfile({ agentCardUrl, ...opts.vendor });

  const validation = validateUcpProfile(profile);
  if (validation.rejected.length > 0) {
    const detail = validation.rejected
      .map((r) => `${r.name} (${r.code})`)
      .join("; ");
    throw new Error(`UCP profile failed validation: ${detail}`);
  }

  return {
    profile: validation.profile,
    cacheControl: `public, max-age=${maxAgeSeconds}`,
    maxAgeSeconds,
  };
}
