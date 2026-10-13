/**
 * A651 包四正式回归：可信 SKU↔平台商品ID 与交易入口政策（launch-marketplace-policy
 * + generic executeHandoff 强制门）。
 *
 * 覆盖（PACK4-READONLY-PLAN 最小验收矩阵 + 经理 2026-10-13 负控校准）：
 *  - SKU 与平台ID：3 平台合法 SKU≠ID 成功；超 Number 精度字符串 ID 保字节；
 *    SKU 当 ID / 科学计数 / 零 / 负 / 前导零拒；
 *  - URL 卫生：exact 3 形态；显式 :443（URL 归一化）、路径 ../（dot 段）、
 *    反斜杠（WHATWG 归一化）、userinfo、fragment、percent 编码、CRLF/空白、
 *    IP/IDN host、缺/重复 id、额外 query 全部拒（raw 与 builder 重建规范串
 *    逐字相等为唯一权威判据）；
 *  - authority：可信 reader 正例交付；缺 sidecar / 绑定错候选 / 来源 digest、
 *    revision、owner、merchant、SKU、fresh_until、declared_uri 变更 →
 *    stale/needs_configuration；模型线索不自证；
 *  - 接缝：generic executeHandoff 无 callback 也不能跳门；opaque
 *    quote/contact/session 类型不受本门影响；
 *  - 重定向：onHop 每跳强制同平台同 opaque ID（同商品允许；换 ID/跨平台拒）；
 *  - 错误卫生：固定分类 reason 不透 URI/query 原文。
 *
 * 本文件为静态交付源码（A651 本轮不执行测试）；运行与独验归 claude-ds。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HandoffEventStore,
  HandoffIdempotencyStore,
  createHandoffCandidate,
  executeHandoff,
  validateExternalDestinationUrl,
  type HandoffCandidate,
  type HandoffLaunchContext,
  type MarketplaceListingSnapshot,
} from "../src/handoff/index.js";
import {
  MarketplaceLaunchPolicyError,
  buildMarketplaceSourceBinding,
  parseMarketplaceTradeUrl,
  sameMarketplaceTarget,
} from "../src/handoff/launch-marketplace-policy.js";
import { CommerceError } from "../src/commerce/data-source.js";

const IDENTITY = { sender_identity: "principal:buyer-1", counterparty_identity: "merchant:acme", actor: "buyer" as const };
const CAPABILITY = { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" };
const NOW = "2026-08-07T09:00:00Z";
const AGREED_TERMS = { items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" } }] };
const CATALOG_ORIGIN = "https://catalog.test";

// ── parseMarketplaceTradeUrl：SKU 与平台ID / URL 卫生 ──────────────────────

describe("parseMarketplaceTradeUrl（三平台确切形态，raw 与 builder 重建逐字相等）", () => {
  it("3 平台合法 SKU≠平台ID 成功；平台 ID 不转 Number 保字节", () => {
    const jd = parseMarketplaceTradeUrl("https://item.jd.com/100301440825.html");
    expect(jd).toMatchObject({ platform: "jd", platform_product_id: "100301440825", declared_uri: "https://item.jd.com/100301440825.html" });
    const tb = parseMarketplaceTradeUrl("https://item.taobao.com/item.htm?id=900719925474099312345");
    // 超 Number.MAX_SAFE_INTEGER 的字符串 ID：byte-preserved（不科学计数）
    expect(tb.platform_product_id).toBe("900719925474099312345");
    expect(tb.platform).toBe("taobao");
    const tm = parseMarketplaceTradeUrl("https://detail.tmall.com/item.htm?id=123456789");
    expect(tm).toMatchObject({ platform: "tmall", platform_product_id: "123456789" });
    // 平台 ID ≠ SKU（opaque ID 语义独立）
    expect(parseMarketplaceTradeUrl("https://item.taobao.com/item.htm?id=1").platform_product_id).toBe("1");
  });

  const rejects = (raw: unknown, code?: MarketplaceLaunchPolicyError["code"]): void => {
    let threw: unknown;
    try {
      parseMarketplaceTradeUrl(raw);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(MarketplaceLaunchPolicyError);
    if (code !== undefined && threw instanceof MarketplaceLaunchPolicyError) {
      expect(threw.code).toBe(code);
    }
  };

  it("显式 :443（URL 归一化 port 为空）拒——raw 与重建串不等（经理负控）", () => {
    rejects("https://item.jd.com:443/100301440825.html");
    rejects("https://item.taobao.com:443/item.htm?id=100301440825");
  });

  it("路径 dot 段 ../ 与反斜杠（WHATWG 归一化）拒（经理负控）", () => {
    rejects("https://item.jd.com/../100301440825.html");
    rejects("https://item.taobao.com/item.htm/../item.htm?id=100301440825");
    rejects("https:\\\\item.taobao.com\\item.htm?id=100301440825");
    rejects("https://item.taobao.com\\item.htm?id=100301440825");
  });

  it("userinfo / fragment / percent 编码 / CRLF / 控制字符 / 空白拒", () => {
    rejects("https://user:pass@item.taobao.com/item.htm?id=100301440825");
    rejects("https://item.taobao.com/item.htm?id=100301440825#top");
    rejects("https://item.taobao.com/item.htm?id=100301440825&x=%20");
    rejects("https://item.taobao.com/item.htm?id=1003014408%2525");
    rejects("https://item.taobao.com/item.htm?id=100301440825\r\nX: y");
    rejects("https://item.taobao.com/item.htm?id= 100301440825");
    rejects("https://item.taobao.com/item.htm?\t id=100301440825");
  });

  it("非 https / IP / IDN / 尾点 / 非三平台 host 拒（unsupported_platform 或形态拒）", () => {
    rejects("http://item.taobao.com/item.htm?id=100301440825");
    rejects("https://192.168.1.1/item.htm?id=100301440825", "unsupported_platform");
    rejects("https://item.taobao.com.evil.example/item.htm?id=100301440825", "unsupported_platform");
    // Node WHATWG URL 保留 hostname 的尾点；host 因而不精确命中三平台表，
    // 按权威解析顺序归类 unsupported_platform。无论分类如何，尾点形态均拒绝。
    rejects("https://item.taobao.com./item.htm?id=100301440825", "unsupported_platform");
    rejects("https://item.jd.com./100301440825.html", "unsupported_platform");
    rejects("https://item.jd.com.evil.example/100301440825.html", "unsupported_platform");
    rejects("https://evil.example/item.htm?id=100301440825", "unsupported_platform");
    // 合法 punycode（bücher.example）host 可被 URL 解析，但不在三平台表。
    rejects("https://xn--bcher-kva.example/item.htm?id=100301440825", "unsupported_platform");
    // URL 语法本身非法时，在 host 分类之前固定归为 trade_uri_invalid。
    rejects("https://[not-an-ipv6]/item.htm?id=100301440825", "trade_uri_invalid");
  });

  it("非 ASCII 数字 / 零 / 负 / 科学计数 / 前导零 ID 拒（platform_id_invalid 或形态拒）", () => {
    rejects("https://item.taobao.com/item.htm?id=１２３"); // 全角数字
    rejects("https://item.taobao.com/item.htm?id=0", "platform_id_invalid");
    rejects("https://item.taobao.com/item.htm?id=-1", "platform_id_invalid");
    rejects("https://item.taobao.com/item.htm?id=1e3", "platform_id_invalid");
    rejects("https://item.taobao.com/item.htm?id=01", "platform_id_invalid");
    rejects("https://item.taobao.com/item.htm?id=1.5", "platform_id_invalid");
    // SKU 当 URL ID：taobao id 位置必须是 ASCII 正整数字符串；非纯数字 SKU 拒
    rejects("https://item.taobao.com/item.htm?id=a515-test-20261012", "platform_id_invalid");
  });

  it("缺 id / 重复 id / 额外 query / 空 query 值拒", () => {
    rejects("https://item.taobao.com/item.htm");
    rejects("https://item.taobao.com/item.htm?");
    rejects("https://item.taobao.com/item.htm?id=100301440825&id=100301440825");
    rejects("https://item.taobao.com/item.htm?id=100301440825&sku=x");
    rejects("https://detail.tmall.com/item.htm?id=123456789&bar=1");
    rejects("https://item.taobao.com/item.htm?id=");
    // JD path 形态带 query 拒
    rejects("https://item.jd.com/100301440825.html?track=1");
    // JD path 多段/缺 .html 拒
    rejects("https://item.jd.com/a/100301440825.html");
    rejects("https://item.jd.com/100301440825");
  });

  it("同平台同 opaque ID 判定：同 ID 允许、换 ID/换平台拒", () => {
    const a = parseMarketplaceTradeUrl("https://item.taobao.com/item.htm?id=100301440825");
    const b = parseMarketplaceTradeUrl("https://item.taobao.com/item.htm?id=100301440825");
    const other = parseMarketplaceTradeUrl("https://item.taobao.com/item.htm?id=100301440826");
    const jd = parseMarketplaceTradeUrl("https://item.jd.com/100301440825.html");
    expect(sameMarketplaceTarget(a, b)).toBe(true);
    expect(sameMarketplaceTarget(a, other)).toBe(false);
    expect(sameMarketplaceTarget(a, jd)).toBe(false);
  });

  it("非字符串/空串/超长输入拒", () => {
    rejects(undefined);
    rejects(null);
    rejects(123);
    rejects("");
    rejects(`https://item.taobao.com/item.htm?id=${"1".repeat(3000)}`);
  });
});

// ── sidecar 构造与执行期核验 ───────────────────────────────────────────────

function trustedListing(overrides: Partial<MarketplaceListingSnapshot> = {}): MarketplaceListingSnapshot {
  return {
    listing_id: "list-001",
    listing_type: "product",
    owner_agent_id: "acme-owner",
    merchant_id: "merchant-acme",
    source_product_ref: "SKU-001",
    source_revision: "rev-1",
    handoff_destination_ref: "https://item.taobao.com/item.htm?id=100301440825",
    listing_digest: "digest-001",
    publication_state: "ACTIVE",
    listing_freshness_state: "FRESH",
    fresh_until: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function bindingInput(
  listing: MarketplaceListingSnapshot,
  overrides: Record<string, unknown> = {},
) {
  return {
    catalogOrigin: CATALOG_ORIGIN,
    listing,
    taskId: "task-1",
    negotiationId: "neg_01JABC",
    agreementId: "agr_01JABC",
    termsDigest: "terms-1",
    candidateDigest: "cand-1",
    observedAt: NOW,
    ...overrides,
  };
}

describe("buildMarketplaceSourceBinding（P4 校准：三平台形态才形成，无自有域 fallback）", () => {
  it("可信 listing → sidecar：平台/ID 来自 listing 声明 URI，快照摘要绑定", () => {
    const binding = buildMarketplaceSourceBinding(bindingInput(trustedListing()));
    expect(binding.binding_version).toBe("marketplace_source_binding/1");
    expect(binding.parsed_platform).toBe("taobao");
    expect(binding.platform_product_id).toBe("100301440825");
    expect(binding.merchant_sku).toBe("SKU-001");
    expect(binding.source_revision).toBe("rev-1");
    // A659：contentDigest 权威合同 = `sha256:` 前缀（negotiation/jcs.ts），
    // 原断言漏前缀属 fixture 错。
    expect(binding.local_snapshot_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("listing 未声明成交入口 / 声明非三平台 URI / 声明错误形态 → 直接拒绝（不降级 null）", () => {
    expect(() => buildMarketplaceSourceBinding(bindingInput(trustedListing({ handoff_destination_ref: undefined })))).toThrow(MarketplaceLaunchPolicyError);
    // 自有域 https URI：P4 不做 fallback，binding 不形成
    expect(() => buildMarketplaceSourceBinding(bindingInput(trustedListing({ handoff_destination_ref: "https://acme.example/checkout/1" })))).toThrow(MarketplaceLaunchPolicyError);
    // 三平台错误 ID / 额外 query：直接拒绝
    expect(() => buildMarketplaceSourceBinding(bindingInput(trustedListing({ handoff_destination_ref: "https://item.taobao.com/item.htm?id=0" })))).toThrow(MarketplaceLaunchPolicyError);
    expect(() => buildMarketplaceSourceBinding(bindingInput(trustedListing({ handoff_destination_ref: "https://item.taobao.com/item.htm?id=100301440825&track=1" })))).toThrow(MarketplaceLaunchPolicyError);
  });
});

function candidate(destinationRef: string, overrides: Record<string, unknown> = {}): HandoffCandidate {
  return createHandoffCandidate({
    agreement_id: "agr_01JABC",
    negotiation_id: "neg_01JABC",
    agreed_terms: AGREED_TERMS,
    destination: { type: "external_checkout_url", ref: destinationRef },
    display_summary: { merchant: "Acme", summary: "200 units" },
    policy_version: "handoff-policy/1",
    expires_at: "2026-08-08T12:00:00Z",
    ...overrides,
  });
}

function launchContext(
  c: HandoffCandidate,
  options: {
    /** 显式传 undefined = 重读缺失（stale）；缺省 = trustedListing()。 */
    fresh?: MarketplaceListingSnapshot | undefined;
    bindingOverrides?: Record<string, unknown>;
  } = {},
): HandoffLaunchContext {
  const fresh = "fresh" in options ? options.fresh : trustedListing();
  return {
    binding: buildMarketplaceSourceBinding(bindingInput(trustedListing(), {
      candidateDigest: c.candidate_digest,
      termsDigest: c.terms_digest,
      ...options.bindingOverrides,
    })),
    readSource: async () => fresh,
    catalogOrigin: CATALOG_ORIGIN,
    taskId: "task-1",
    agreedSku: "SKU-001",
    ownerAgentId: "acme-owner",
  };
}

const tmpDirs: string[] = [];
function trackedMkdtemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readyEnv(c: HandoffCandidate, extra: Record<string, unknown> = {}, markReady = true) {
  const dir = trackedMkdtemp("kiwi-launch-");
  const ledger = new HandoffEventStore({ dir });
  const idempotency = new HandoffIdempotencyStore({ dir });
  ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
  if (markReady) {
    ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
  }
  return {
    ledger,
    idempotency,
    identity: IDENTITY,
    capability: CAPABILITY,
    now: () => NOW,
    approval: async () => ({ approved: true }),
    agreementReader: async () => ({ agreement_id: c.agreement_id, negotiation_id: c.negotiation_id, agreed_terms: AGREED_TERMS }),
    ...extra,
  };
}

describe("generic executeHandoff 三平台 URL 交易强制门（接缝：无 callback 可跳）", () => {
  const DEST = "https://item.taobao.com/item.htm?id=100301440825";

  it("正例：真实 trusted listing/context → delivered（原交付断言保留）", async () => {
    const c = candidate(DEST);
    const result = await executeHandoff({ ...readyEnv(c), candidate: c, launchContext: launchContext(c) });
    expect(result.kind).toBe("delivered");
  });

  it("无 launchContext（缺 sidecar）→ needs_configuration，不交付、不改候选终态", async () => {
    const c = candidate(DEST);
    const e = readyEnv(c);
    const result = await executeHandoff({ ...e, candidate: c });
    expect(result).toMatchObject({ kind: "needs_configuration" });
    const kinds = e.ledger.events(c.negotiation_id).map((ev) => ev.event_kind);
    expect(kinds).not.toContain("handoff_delivered");
    expect(kinds).not.toContain("handoff_candidate_stale");
    expect(kinds).not.toContain("handoff_candidate_consumed");
  });

  it("binding 绑定错候选（candidate_digest 不匹配）→ stale，需原审批流程新确认", async () => {
    const c = candidate(DEST);
    const e = readyEnv(c);
    const result = await executeHandoff({
      ...e,
      candidate: c,
      launchContext: launchContext(c, { bindingOverrides: { candidateDigest: "cand-other" } }),
    });
    expect(result).toMatchObject({ kind: "stale", reason: /candidate/ });
    expect(e.ledger.events(c.negotiation_id).map((ev) => ev.event_kind)).toContain("handoff_candidate_stale");
  });

  const staleCases: Array<[string, MarketplaceListingSnapshot | undefined]> = [
    ["listing_digest 变更", trustedListing({ listing_digest: "digest-002" })],
    ["source_revision 变更", trustedListing({ source_revision: "rev-2" })],
    ["owner 变更", trustedListing({ owner_agent_id: "other-owner" })],
    ["merchant 变更", trustedListing({ merchant_id: "merchant-other" })],
    ["SKU 变更", trustedListing({ source_product_ref: "SKU-002" })],
    ["declared_uri 变更", trustedListing({ handoff_destination_ref: "https://item.taobao.com/item.htm?id=100301440826" })],
    ["fresh_until 过期", trustedListing({ fresh_until: "2026-08-07T00:00:00Z" })],
    ["非 ACTIVE", trustedListing({ publication_state: "WITHDRAWN" })],
    ["非 FRESH", trustedListing({ listing_freshness_state: "STALE" })],
    ["capability listing", trustedListing({ listing_type: "capability" })],
    ["重读缺失", undefined],
  ];
  it.each(staleCases)("执行期新鲜重读 %s → stale（来源变更需重新审批）", async (_name, fresh) => {
    const c = candidate(DEST);
    const e = readyEnv(c);
    const result = await executeHandoff({
      ...e,
      candidate: c,
      launchContext: launchContext(c, { fresh }),
    });
    expect(result.kind).toBe("stale");
    expect(e.ledger.events(c.negotiation_id).map((ev) => ev.event_kind)).toContain("handoff_candidate_stale");
    expect(e.ledger.events(c.negotiation_id).map((ev) => ev.event_kind)).not.toContain("handoff_delivered");
  });

  it("来源变更使旧绑定 stale；为新鲜快照重新确认后可交付", async () => {
    const oldCandidate = candidate(DEST);
    const oldEnv = readyEnv(oldCandidate);
    const changedListing = trustedListing({ listing_digest: "digest-after-change", source_revision: "rev-2" });
    const stale = await executeHandoff({
      ...oldEnv,
      candidate: oldCandidate,
      launchContext: launchContext(oldCandidate, { fresh: changedListing }),
    });
    expect(stale.kind).toBe("stale");
    expect(oldEnv.ledger.events(oldCandidate.negotiation_id).map((ev) => ev.event_kind)).not.toContain("handoff_delivered");

    // 新候选代表原审批流程中的重新确认：sidecar 绑定本次变化后的可信快照，
    // generic 门仍然执行一次新的 approval callback 才允许交付。
    const confirmedCandidate = candidate(DEST);
    const confirmedEnv = readyEnv(confirmedCandidate, {}, false);
    let approvalCalls = 0;
    const result = await executeHandoff({
      ...confirmedEnv,
      candidate: confirmedCandidate,
      approval: async () => {
        approvalCalls += 1;
        return { approved: true };
      },
      launchContext: {
        binding: buildMarketplaceSourceBinding(bindingInput(changedListing, {
          candidateDigest: confirmedCandidate.candidate_digest,
          termsDigest: confirmedCandidate.terms_digest,
        })),
        readSource: async () => changedListing,
        catalogOrigin: CATALOG_ORIGIN,
        taskId: "task-1",
        agreedSku: "SKU-001",
        ownerAgentId: "acme-owner",
      },
    });
    expect(approvalCalls).toBe(1);
    expect(result.kind).toBe("delivered");
  });

  it("agreedSku 与协议条款不一致 → stale（SKU 绑定不可绕过）", async () => {
    const c = candidate(DEST);
    const e = readyEnv(c);
    const ctx = launchContext(c);
    const result = await executeHandoff({ ...e, candidate: c, launchContext: { ...ctx, agreedSku: "SKU-OTHER" } });
    expect(result.kind).toBe("stale");
  });

  it("reader 瞬时失败（request_failed）→ probe_failed（候选保持 READY 可重试）", async () => {
    const c = candidate(DEST);
    const e = readyEnv(c);
    const ctx = launchContext(c);
    const result = await executeHandoff({
      ...e,
      candidate: c,
      launchContext: {
        ...ctx,
        readSource: async () => {
          throw new CommerceError("request_failed", "catalog temporarily unreachable");
        },
      },
    });
    expect(result).toMatchObject({ kind: "probe_failed" });
    const kinds = e.ledger.events(c.negotiation_id).map((ev) => ev.event_kind);
    expect(kinds).not.toContain("handoff_candidate_stale");
    expect(kinds).not.toContain("handoff_delivered");
  });

  it("非市场形态 URL（自有域）不走本门，保持原 host 门路径（既有语义）", async () => {
    const c = candidate("https://acme.example/checkout/abc");
    const result = await executeHandoff({ ...readyEnv(c), candidate: c });
    expect(result.kind).toBe("delivered");
  });

  it("opaque 目的地（quote_document）不受本门影响（独立语义保持）", async () => {
    const opaque = createHandoffCandidate({
      agreement_id: "agr_01JABC",
      negotiation_id: "neg_01JABC",
      agreed_terms: AGREED_TERMS,
      destination: { type: "quote_document", ref: "Q-DOC-001" },
      display_summary: { merchant: "Acme", summary: "200 units" },
      policy_version: "handoff-policy/1",
      expires_at: "2026-08-08T12:00:00Z",
    });
    const result = await executeHandoff({ ...readyEnv(opaque), candidate: opaque });
    expect(result.kind).toBe("delivered");
  });

  it("错误卫生：stale reason 固定分类，不透 URI query 原文", async () => {
    const c = candidate(DEST);
    const e = readyEnv(c);
    const result = await executeHandoff({
      ...e,
      candidate: c,
      launchContext: launchContext(c, { fresh: trustedListing({ handoff_destination_ref: "https://item.taobao.com/item.htm?id=100301440826" }) }),
    });
    expect(result.kind).toBe("stale");
    if (result.kind === "stale") {
      expect(result.reason).not.toContain("100301440826");
      expect(result.reason).not.toContain("item.htm");
    }
  });
});

// ── 重定向：onHop 每跳强制同平台同 opaque ID ──────────────────────────────

describe("重定向每跳收紧（validateExternalDestinationUrl onHop）", () => {
  const START = "https://item.taobao.com/item.htm?id=100301440825";
  const target = parseMarketplaceTradeUrl(START);
  const onHop = (hopUrl: string): void => {
    let parsed;
    try {
      parsed = parseMarketplaceTradeUrl(hopUrl);
    } catch {
      throw new CommerceError("invalid_input", "destination hop left the marketplace trade form");
    }
    if (!sameMarketplaceTarget(parsed, target)) {
      throw new CommerceError("invalid_input", "destination redirect changed platform product identity");
    }
  };
  const baseOptions = {
    allowlist: ["item.taobao.com"],
    allowHttp: false,
    skipDnsCheck: true,
    resolveIp: async () => ["203.0.113.7"],
  };

  it("同商品重定向（同平台同 ID）允许", async () => {
    let heads = 0;
    const fetchImpl = (async () => {
      heads += 1;
      if (heads === 1) {
        return new Response(null, { status: 302, headers: { location: START } });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const safe = await validateExternalDestinationUrl(START, {
      ...baseOptions,
      fetchImpl,
      onHop,
    });
    expect(safe.finalUrl).toBe(START);
    expect(safe.redirects).toHaveLength(1);
  });

  it("重定向换平台商品 ID → 拒（CommerceError invalid_input）", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: "https://item.taobao.com/item.htm?id=100301440826" } })) as typeof fetch;
    await expect(
      validateExternalDestinationUrl(START, { ...baseOptions, fetchImpl, onHop }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("重定向跨平台（同 ID 不同平台 host）→ 拒", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: "https://detail.tmall.com/item.htm?id=100301440825" } })) as typeof fetch;
    await expect(
      validateExternalDestinationUrl(START, { ...baseOptions, fetchImpl, onHop }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
