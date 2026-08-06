/**
 * 不降级不变量测试（基线 §36-21）：Direct Channel 失败不得自动降级到权限更宽的
 * Channel。
 *
 * 候选选择是一次性确定性决策（§33 selectChannelCandidate：direct → hosted →
 * platform）；openChannel 只构造选定候选，**没有**失败后重试更宽候选的机制。
 * 本套件证明：
 *   - 选择顺序确定（direct 优先于 hosted 优先于 platform）；
 *   - direct 失败（远端不可达）→ 抛 ChannelError，hosted commerce client 从未被触达；
 *   - direct 候选结构缺失（无 url）→ no_channel_candidate，不回落 hosted；
 *   - 仅 hosted → 打开 hosted；仅 platform 未配置 → platform_not_configured；
 *   - 无候选 → no_channel_candidate（fail-closed）。
 */
import { describe, expect, it } from "vitest";
import { openChannel, selectChannelCandidate } from "../src/counterparty/index.js";
import type {
  ChannelCandidate,
  ChannelOpenInput,
  CounterpartyProfile,
} from "../src/counterparty/index.js";
import type { AgentCard } from "../src/discovery/index.js";
import { createFakeMarketplace } from "../src/commerce/fake-client.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { NEGOTIATION_ID, validEnvelopeFields } from "./negotiation-helpers.js";

const CARD: AgentCard = {
  name: "merchant",
  description: "test merchant",
  provider: { organization: "merchant" },
  version: "1.0",
  supportedInterfaces: [
    { url: "http://127.0.0.1:1/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
};

function profile(candidates: ChannelCandidate[]): CounterpartyProfile {
  return {
    identity: "merchant",
    source: "card:test",
    agent_card: CARD,
    intersection: {
      compatible: candidates.some((c) => c.kind === "a2a-direct"),
      candidates: candidates.filter((c) => c.kind === "a2a-direct").map((c) => ({ url: c.url ?? "", protocolBinding: "JSONRPC", protocolVersion: "1.0" })),
      selected: undefined,
      incompatible: [],
      unknownShared: [],
      oneSided: [],
    },
    channel_candidates: candidates,
  };
}

const OPEN_INPUT: ChannelOpenInput = {
  negotiation_id: NEGOTIATION_ID,
  sender_identity: "kiwi-buyer",
  identity: "merchant",
};

const NOW = "2026-08-06T10:00:00.000Z";

describe("不变量 21：Direct 失败不得自动降级到权限更宽的 Channel", () => {
  it("selectChannelCandidate 确定性顺序：direct → hosted → platform", () => {
    const p = profile([
      { kind: "platform-api", credential_ref: "plat:1" },
      { kind: "shopping-cli-hosted", config_id: "local" },
      { kind: "a2a-direct", url: "http://127.0.0.1:1/a2a" },
    ]);
    expect(selectChannelCandidate(p)?.kind).toBe("a2a-direct");
  });

  it("direct 远端不可达 → send 抛 ChannelError，hosted commerce client 从未被触达", async () => {
    let commerceCalls = 0;
    const mk = createFakeMarketplace({
      merchant_id: "merchant-001",
      buyer_id: "buyer-001",
      product: {
        sku: "SKU-001",
        title: "widget",
        currency: "CNY",
        list_price: 100,
        stock_quantity: 10,
        delivery: { eta_start: "2026-08-10T00:00:00Z", eta_end: "2026-08-11T00:00:00Z", fee: 5 },
        policies: [{ ref: "POL-1", summary: "7-day returns" }],
      },
      now: NOW,
    });
    const deps = {
      commerce: () => {
        commerceCalls += 1;
        return mk.merchant;
      },
    };
    const handle = await openChannel(
      profile([
        { kind: "a2a-direct", url: "http://127.0.0.1:1/" }, // 不可达
        { kind: "shopping-cli-hosted", config_id: "local" },
      ]),
      deps,
      OPEN_INPUT,
    );

    await expect(handle.send({ envelope: finalizeEnvelope(validEnvelopeFields()) })).rejects.toMatchObject({
      channel: "a2a-direct",
      code: "send_failed",
    });
    // 核心断言：选择是一次性的，失败不回落 hosted。
    expect(commerceCalls).toBe(0);
    await handle.close();
  });

  it("direct 候选结构缺失（无 url）→ no_channel_candidate，不回落 hosted", async () => {
    let commerceCalls = 0;
    const deps = {
      commerce: () => {
        commerceCalls += 1;
        return null;
      },
    };
    await expect(
      openChannel(profile([{ kind: "a2a-direct" }, { kind: "shopping-cli-hosted", config_id: "local" }]), deps, OPEN_INPUT),
    ).rejects.toMatchObject({ code: "no_channel_candidate" });
    expect(commerceCalls).toBe(0);
  });

  it("仅 hosted → 打开 hosted（commerce client 被触达）", async () => {
    const mk = createFakeMarketplace({
      merchant_id: "merchant-001",
      buyer_id: "buyer-001",
      product: {
        sku: "SKU-001",
        title: "widget",
        currency: "CNY",
        list_price: 100,
        stock_quantity: 10,
        delivery: { eta_start: "2026-08-10T00:00:00Z", eta_end: "2026-08-11T00:00:00Z", fee: 5 },
        policies: [{ ref: "POL-1", summary: "7-day returns" }],
      },
      now: NOW,
    });
    const handle = await openChannel(
      profile([{ kind: "shopping-cli-hosted", config_id: "local" }]),
      { commerce: () => mk.merchant },
      {
        ...OPEN_INPUT,
        remote: { conversation_id: "conv-merchant-001", message_id: 1 },
      },
    );
    expect(handle.kind).toBe("shopping-cli-hosted");
    await handle.close();
  });

  it("仅 platform 未配置 → platform_not_configured（fail-closed）", async () => {
    await expect(
      openChannel(profile([{ kind: "platform-api", credential_ref: "plat:1" }]), { platform: { configured: false } }, OPEN_INPUT),
    ).rejects.toMatchObject({ channel: "platform-api", code: "platform_not_configured" });
  });

  it("无候选 → no_channel_candidate（fail-closed）", async () => {
    await expect(openChannel(profile([]), {}, OPEN_INPUT)).rejects.toMatchObject({
      code: "no_channel_candidate",
    });
  });
});
