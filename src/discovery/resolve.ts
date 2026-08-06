/**
 * AgentDiscovery.resolve —— §33 AgentDiscovery 职责落地。
 *
 * 输入 domain 或 Agent Card URL：
 *
 *   domain        → well-known Agent Card（`https://<domain>/.well-known/agent-card.json`，
 *                   对齐 A2AServer 的默认 wellKnownPath）；
 *   agentCardUrl  → 直接拉取 Agent Card。
 *
 * 处理链：
 *   fetch → parseAgentCard（结构校验 + secret 扫描，不变量 24）→
 *   capability intersection（§3.1 / §33）→ identity bootstrap → channel candidates。
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
import type { ChannelCandidate, CounterpartyProfile } from "../counterparty/channel.js";

export interface DiscoveryInput {
  /** 对端域名（不含 scheme）；从 well-known Agent Card 解析。 */
  domain?: string;
  /** 直接给 Agent Card URL。 */
  agentCardUrl?: string;
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

export class AgentDiscovery {
  private readonly deps: DiscoveryDeps;

  constructor(deps: DiscoveryDeps = {}) {
    this.deps = deps;
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
    const raw = await this.fetchCard(url);

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
    };
  }
}
