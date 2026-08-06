/**
 * AgentDiscovery.resolve —— §33 AgentDiscovery 职责落地。
 *
 * 输入 domain 或 Agent Card URL：
 *
 *   domain        → 双发现入口（基线 §25 / §33，WP3）：
 *                     1. 先试 UCP 标准入口 `/.well-known/ucp`；
 *                        解析成功且校验后 profile 含 a2a transport → 用其
 *                        endpoint（Agent Card URL）继续；
 *                     2. UCP 失败（解析/校验/无 a2a transport）→ 回退直接试
 *                        `https://<domain>/.well-known/agent-card.json`。
 *                     两个都是标准发现入口，权限等价，因此 UCP → Agent Card
 *                     的回退不违反不变量 21 —— 不变量 21 约束的是通道候选的
 *                     一次性选择，不是发现入口本身。
 *   agentCardUrl  → 直接拉取 Agent Card（不走 UCP）。
 *
 * 处理链：
 *   fetch → parseAgentCard（结构校验 + secret 扫描，不变量 24）→
 *   capability intersection（§3.1 / §33）→ identity bootstrap → channel candidates。
 *   UCP 优先路径成功时，UCP capability intersection（§3.2，与 A2A binding
 *   intersection 两个维度并存）与解析出的 profile 一并放入 CounterpartyProfile。
 *
 * 通道候选按优先序（§33）：A2A 可用 → a2a-direct；否则若配置了 hosted →
 * shopping-cli-hosted；否则若配置了 platform → platform-api；都没有 → fail-closed
 * （抛 DiscoveryError）。候选选择本身是一次性确定性决策（selectChannelCandidate），
 * 后续失败绝不自动降级到权限更宽的通道（不变量 21）。
 *
 * 全部失败路径抛 DiscoveryError（fail-closed，§4.6）。
 */

import { AgentCardError, parseAgentCard, type AgentCard, type AgentInterface } from "./agent-card/index.js";
import { intersectCapabilities } from "./capability/index.js";
import type { CapabilityIntersection } from "./capability/index.js";
import { UcpResolver } from "./ucp/resolver.js";
import type { UcpResolverOptions } from "./ucp/resolver.js";
import { isUcpError } from "./ucp/error.js";
import { computeCapabilityIntersection, intersectionView } from "./ucp/intersect.js";
import type { UcpIntersectionView } from "./ucp/intersect.js";
import type { UcpProfile } from "./ucp/types.js";
import type { ChannelCandidate, CounterpartyProfile } from "../counterparty/channel.js";

export interface DiscoveryInput {
  /** 对端域名（不含 scheme）；从 well-known Agent Card 解析。 */
  domain?: string;
  /** 直接给 Agent Card URL。 */
  agentCardUrl?: string;
}

/** UCP 优先发现配置（WP3，可选）。 */
export interface UcpDiscoveryDeps {
  /** 禁用 UCP 优先发现（domain 输入），保持 v0.5 直接 well-known Agent Card。 */
  disabled?: boolean;
  /** Kiwi 平台侧 UCP profile（capability intersection 的 platform 侧）。 */
  localProfile?: UcpProfile;
  /** UcpResolver 构造选项（fetchImpl 缺省复用 discovery.fetchImpl）。 */
  resolver?: UcpResolverOptions;
}

export interface DiscoveryDeps {
  /** 拉取 card 的 fetch；缺省 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** Kiwi 本地 A2A binding 声明（capability intersection 的 local 侧）。 */
  localInterfaces?: AgentInterface[];
  /** hosted 通道是否已配置（§33：非 direct 时的次选）。 */
  hosted?: { configured: boolean; config_id?: string };
  /** platform 通道是否已配置（fail-closed：未配置不产生候选）。 */
  platform?: { configured: boolean; credential_ref?: string };
  /** 拉取超时 ms（默认 15000）。 */
  timeoutMs?: number;
  /**
   * UCP 集成（WP3）：domain 输入先试 `/.well-known/ucp`，失败回退
   * `/.well-known/agent-card.json`。缺省启用（不传即用默认 resolver）；
   * `disabled: true` 保持 v0.5 行为。
   */
  ucp?: UcpDiscoveryDeps;
}

export type DiscoveryErrorCode =
  | "invalid_input"
  | "card_fetch_failed"
  | "card_invalid"
  | "card_has_secret"
  | "no_channel_candidate";

export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;
  constructor(code: DiscoveryErrorCode, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}

/** Kiwi 本地默认 A2A binding：JSONRPC 1.0（基线 §3.1 core binding）。 */
const DEFAULT_LOCAL_INTERFACES: AgentInterface[] = [
  { url: "https://kiwi.local/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
];

const WELL_KNOWN_AGENT_CARD_PATH = "/.well-known/agent-card.json";

/**
 * 从校验后的 UCP profile 挑出 a2a transport 服务的 endpoint（Agent Card URL）。
 * validate 已保证 a2a service 必有 https endpoint；这里只需按序遍历取第一个。
 */
function findA2aTransportEndpoint(profile: UcpProfile): string | undefined {
  const services = profile.ucp.services;
  if (services === undefined) return undefined;
  for (const declarations of Object.values(services)) {
    for (const decl of declarations) {
      if (decl.transport === "a2a" && decl.endpoint !== undefined) return decl.endpoint;
    }
  }
  return undefined;
}

export class AgentDiscovery {
  private readonly deps: DiscoveryDeps;
  private readonly ucpResolver: UcpResolver | undefined;
  private readonly ucpLocalProfile: UcpProfile | undefined;

  constructor(deps: DiscoveryDeps = {}) {
    this.deps = deps;
    const ucpDeps = deps.ucp;
    if (ucpDeps === undefined || ucpDeps.disabled === true) {
      this.ucpResolver = undefined;
      this.ucpLocalProfile = undefined;
      return;
    }
    this.ucpLocalProfile = ucpDeps.localProfile;
    this.ucpResolver = new UcpResolver({
      ...ucpDeps.resolver,
      fetchImpl: ucpDeps.resolver?.fetchImpl ?? deps.fetchImpl,
      timeoutMs: ucpDeps.resolver?.timeoutMs ?? deps.timeoutMs ?? 15_000,
    });
  }

  private cardUrlFor(input: DiscoveryInput): string {
    if (input.agentCardUrl !== undefined && input.domain !== undefined) {
      throw new DiscoveryError(
        "invalid_input",
        "DiscoveryInput must provide exactly one of domain or agentCardUrl",
      );
    }
    if (input.agentCardUrl !== undefined) return input.agentCardUrl;
    if (input.domain !== undefined) {
      let url: URL;
      try {
        url = new URL(`https://${input.domain}${WELL_KNOWN_AGENT_CARD_PATH}`);
      } catch {
        throw new DiscoveryError("invalid_input", `domain is not a valid host: "${input.domain}"`);
      }
      if (url.hostname.length === 0 || url.username !== "" || url.password !== "") {
        throw new DiscoveryError("invalid_input", `domain is not a valid host: "${input.domain}"`);
      }
      return url.href;
    }
    throw new DiscoveryError("invalid_input", "DiscoveryInput must provide domain or agentCardUrl");
  }

  private async fetchCard(url: string): Promise<unknown> {
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.deps.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    } catch (err) {
      throw new DiscoveryError(
        "card_fetch_failed",
        `failed to fetch Agent Card from ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new DiscoveryError("card_fetch_failed", `Agent Card fetch returned HTTP ${response.status} from ${url}`);
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new DiscoveryError("card_fetch_failed", `Agent Card response from ${url} is not valid JSON`);
    }
    return raw;
  }

  private identityFor(card: AgentCard): string {
    const org = card.provider.organization;
    return org.length > 0 ? org : card.name;
  }

  private channelCandidates(card: AgentCard): {
    intersection: CapabilityIntersection;
    candidates: ChannelCandidate[];
  } {
    const local = this.deps.localInterfaces ?? DEFAULT_LOCAL_INTERFACES;
    const intersection = intersectCapabilities(local, card);

    const candidates: ChannelCandidate[] = [];
    if (intersection.selected !== undefined) {
      candidates.push({ kind: "a2a-direct", url: intersection.selected.url });
    }
    if (this.deps.hosted?.configured === true) {
      candidates.push({ kind: "shopping-cli-hosted", config_id: this.deps.hosted.config_id });
    }
    if (this.deps.platform?.configured === true) {
      candidates.push({ kind: "platform-api", credential_ref: this.deps.platform.credential_ref });
    }
    return { intersection, candidates };
  }

  /**
   * 解析对端：domain 或 Agent Card URL → CounterpartyProfile。
   * 无可用通道候选时抛 DiscoveryError（fail-closed，不返回空档案）。
   */
  async resolve(input: DiscoveryInput): Promise<CounterpartyProfile> {
    const url = this.cardUrlFor(input);

    // WP3 双发现入口（domain 输入）：
    //   1. 先试 /.well-known/ucp（UcpResolver 内含 HTTPS-only / SSRF / 重定向 /
    //      Cache-Control / 结构校验，全部 fail-closed）；
    //   2. 成功且校验后 profile 含 a2a transport → 用其 endpoint（Agent Card URL）
    //      继续拉 Agent Card；任何失败 → 回退 /.well-known/agent-card.json。
    // 回退不违反不变量 21：UCP 与 Agent Card 是权限等价的两个标准发现入口，
    // 不变量 21 约束的是通道候选的一次性选择，不是发现入口。
    let ucpProfile: UcpProfile | undefined;
    let ucpIntersection: UcpIntersectionView | undefined;
    let ucpFallbackReason: string | undefined;
    let cardUrl = url;

    if (input.domain !== undefined && this.ucpResolver !== undefined) {
      try {
        const ucpResult = await this.ucpResolver.resolve({ domain: input.domain });
        const endpoint = findA2aTransportEndpoint(ucpResult.profile);
        if (endpoint === undefined) {
          ucpFallbackReason =
            "UCP profile is valid but declares no a2a transport endpoint (fallback to well-known Agent Card)";
        } else {
          cardUrl = endpoint;
          ucpProfile = ucpResult.profile;
          if (this.ucpLocalProfile !== undefined) {
            ucpIntersection = intersectionView(
              computeCapabilityIntersection(ucpResult.profile, this.ucpLocalProfile),
            );
          }
        }
      } catch (err) {
        const detail =
          isUcpError(err)
            ? `ucp:${err.code}`
            : `ucp:unexpected:${err instanceof Error ? err.message : String(err)}`;
        ucpFallbackReason = `${detail} (fallback to well-known Agent Card)`;
      }
    }

    const raw = await this.fetchCard(cardUrl);

    let card: AgentCard;
    try {
      card = parseAgentCard(raw);
    } catch (err) {
      if (err instanceof AgentCardError) {
        throw new DiscoveryError(
          err.code === "secret_found" ? "card_has_secret" : "card_invalid",
          `Agent Card failed validation: ${err.message}`,
        );
      }
      throw new DiscoveryError(
        "card_invalid",
        `Agent Card failed validation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const { intersection, candidates } = this.channelCandidates(card);
    if (candidates.length === 0) {
      throw new DiscoveryError(
        "no_channel_candidate",
        `no usable channel candidate for Agent Card "${card.name}": no compatible A2A binding and no hosted/platform configured (fail-closed)`,
      );
    }

    return {
      identity: this.identityFor(card),
      source: input.agentCardUrl !== undefined ? `card:${input.agentCardUrl}` : `domain:${input.domain ?? url}`,
      agent_card: card,
      intersection,
      channel_candidates: candidates,
      ...(ucpProfile !== undefined ? { ucp_profile: ucpProfile } : {}),
      ...(ucpIntersection !== undefined ? { ucp_intersection: ucpIntersection } : {}),
      ...(ucpFallbackReason !== undefined ? { ucp_fallback_reason: ucpFallbackReason } : {}),
    };
  }
}
