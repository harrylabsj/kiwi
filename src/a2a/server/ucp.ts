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
 * UCP Profile 服务化（WP3，基线 §25 / §8.3 / §43）。
 *
 * merchant 侧从 AgentCardConfig 生成 UCP Profile 并在 `GET /.well-known/ucp`
 * 上发布（UCP 规范强制的标准发现入口）。
 *
 * **单一 canonical 模型（审查 P1-03）**：UCP Profile 的领域模型只以
 * `discovery/ucp/types.ts` 的 `UcpProfile`（`ucp: { version, services,
 * capabilities }`）为准，构造入口统一走 `buildKiwiVendorProfile`（AgentCardConfig
 * → UcpProfile 的唯一 adapter）。`buildUcpProfile` 产物强制过 `validateUcpProfile`
 * 自洽校验（round-trip 不变量，fail-closed：被拒条目存在即抛错，不发布坏
 * profile）——不允许发布侧另立一套顶层形状与校验器分叉。
 *
 * 条目元数据（version / spec / schema）由构造器补齐：capability 声明携带
 * version + spec + schema（origin 与 namespace authority 绑定），service 声明
 * 携带 version + spec + a2a transport + endpoint（指向本 server 的 Agent Card
 * URL）。
 *
 * 响应头 Cache-Control 由 buildUcpProfile 计算（`public, max-age=N`，N>=60）。
 * 零新增依赖。
 */

import { WELL_KNOWN_UCP_PATH } from "../../discovery/ucp/resolver.js";
import { buildKiwiVendorProfile } from "../../discovery/ucp/vendor.js";
import { validateUcpProfile } from "../../discovery/ucp/validate.js";
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
  /** canonical UcpProfile（已过 validateUcpProfile，无被拒条目）。 */
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
 * 从本地 Agent Card 配置生成 canonical UCP Profile（发布侧）。
 *
 * 构造走唯一 adapter `buildKiwiVendorProfile`（capability / service 声明补齐
 * version / spec / schema 元数据），产物再强制过 `validateUcpProfile`
 * （round-trip 不变量，审查 P1-03）：任何被拒条目 → 抛错，不发布坏 profile。
 * a2a service 的 endpoint 指向本 server 的 Agent Card URL，因此 baseUrl 必须
 * 是 https（UCP 规范）；http baseUrl 会被 validateUcpProfile 以 endpoint_invalid
 * 拒绝（fail-closed）。
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

  // 审查 P1-03：buildUcpProfile 产物必须能 round-trip 过 validateUcpProfile
  // （canonical model 的权威校验）。构造器产物不被直接信任，fail-closed。
  const validation = validateUcpProfile(profile);
  if (validation.rejected.length > 0) {
    const detail = validation.rejected
      .map((r) => `${r.kind}:${r.name} (${r.code})`)
      .join("; ");
    throw new Error(`UCP profile failed validation: ${detail}`);
  }

  return {
    profile: validation.profile,
    cacheControl: `public, max-age=${maxAgeSeconds}`,
    maxAgeSeconds,
  };
}
