/**
 * trust/records — WP1 CounterpartyTrustRecord（基线 §27 / §28）。
 *
 * 覆盖：
 *   - 持久化与重启还原（0700/0600 原子写；损坏记录 fail-closed → null）；
 *   - 各观察计数（成功交换 / schema 失败 / 超时 / 重放 / 签名失败 / dispute 去重）；
 *   - 评估矩阵（升级 T0→T1→T2→T3、拒绝、降级、保守封顶、自定义阈值）；
 *   - Reputation unknown 语义（无数据绝不 0.5）；
 *   - Agent Card 指纹变更检测（告警信号 + 持久化计数 + 跨重启可见）；
 *   - TrustPolicy 集成（record 输入：rejected 直接拒绝、冲突取更保守者）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_TRUST_EVALUATOR_CONFIG,
  TrustRecordStore,
  computeAgentCardFingerprint,
  evaluateTrustRecord,
  recordPolicyInput,
} from "../src/trust/records/index.js";
import type { ReputationSource, TrustRecordFacts } from "../src/trust/records/index.js";
import {
  conservativeLevel,
  DEFAULT_TRUST_POLICY,
  evaluatePolicy,
} from "../src/trust/identity/index.js";

const ID = "acme.example";
const OTHER = "other.example";

const FP_A = computeAgentCardFingerprint({
  name: "Acme",
  provider: { organization: "Acme" },
  version: "1.0",
});
const FP_B = computeAgentCardFingerprint({
  name: "Acme",
  provider: { organization: "Acme" },
  version: "2.0",
});

/** 单调递增的 RFC 3339 时间戳。 */
const T = (i: number): string => `2026-08-06T00:00:${String(i).padStart(2, "0")}.000Z`;

const workDirs: string[] = [];
afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-trust-records-"));
  workDirs.push(dir);
  return dir;
}

/** 一条默认 exchange_success 观察（tests 里可覆盖字段）。 */
function exchange(
  overrides: Partial<import("../src/trust/records/index.js").TrustObservation> = {},
): import("../src/trust/records/index.js").TrustObservation {
  return { counterparty_identity: ID, kind: "exchange_success", observed_at: T(1), ...overrides };
}

/** 纯事实面构造（评估器单测用；结论字段不参与推导）。 */
function facts(overrides: Partial<TrustRecordFacts> = {}): TrustRecordFacts {
  return {
    counterparty_identity: ID,
    successful_exchanges: 0,
    consecutive_verified_exchanges: 0,
    invalid_schema_count: 0,
    timeout_count: 0,
    replay_detected_count: 0,
    signature_failure_count: 0,
    local_asserted_disputes: [],
    fingerprint_changes: 0,
    ...overrides,
  };
}

describe("持久化与重启还原", () => {
  it("observe 后新 store 实例还原同一 record（计数 / 指纹 / 结论）", () => {
    const dir = freshDir();
    const store = new TrustRecordStore({ dir });
    store.observe(
      exchange({
        observed_at: T(1),
        agent_card_fingerprint: FP_A,
        domain: ID,
        capability_versions: { negotiate: "1.0" },
      }),
    );
    store.observe(exchange({ observed_at: T(2), agent_card_fingerprint: FP_A }));
    store.observe(exchange({ observed_at: T(3), agent_card_fingerprint: FP_A }));
    store.observe({ counterparty_identity: ID, kind: "schema_invalid", observed_at: T(4) });

    const restored = new TrustRecordStore({ dir });
    const record = restored.get(ID);
    expect(record).not.toBeNull();
    expect(record!.successful_exchanges).toBe(3);
    expect(record!.consecutive_verified_exchanges).toBe(3);
    expect(record!.invalid_schema_count).toBe(1);
    expect(record!.agent_card_fingerprint).toBe(FP_A);
    expect(record!.capability_versions).toEqual({ negotiate: "1.0" });
    expect(record!.domain).toBe(ID);
    expect(record!.trust_level).toBe("T2");
    expect(record!.first_seen).toBe(T(1));
    expect(record!.last_seen).toBe(T(4));
    expect(record!.rejected).toBe(false);
  });

  it("目录 0700、文件 0600", () => {
    const dir = freshDir();
    const store = new TrustRecordStore({ dir });
    store.observe(exchange());

    const trustDir = path.join(dir, "trust");
    expect(statSync(trustDir).mode & 0o777).toBe(0o700);
    const files = readdirSync(trustDir);
    const file = files.find((f) => f.endsWith(".json"));
    expect(file).toBeDefined();
    expect(statSync(path.join(trustDir, file!)).mode & 0o777).toBe(0o600);
  });

  it("损坏记录 → get 返回 null（对端视为未知，fail-closed）", () => {
    const dir = freshDir();
    const store = new TrustRecordStore({ dir });
    store.observe(exchange());
    const trustDir = path.join(dir, "trust");
    const file = readdirSync(trustDir).find((f) => f.endsWith(".json"))!;
    writeFileSync(path.join(trustDir, file), "{ not json");
    expect(store.get(ID)).toBeNull();
  });

  it("evaluate() 对未知对端返回 null；list() 列出已落账身份", () => {
    const dir = freshDir();
    const store = new TrustRecordStore({ dir });
    expect(store.evaluate(ID)).toBeNull();
    store.observe(exchange({ observed_at: T(1) }));
    store.observe({ counterparty_identity: OTHER, kind: "exchange_success", observed_at: T(1) });
    expect(store.list().sort()).toEqual([ID, OTHER].sort());
    expect(store.has(ID)).toBe(true);
    expect(store.has("missing")).toBe(false);
  });

  it("空 identity 抛 TypeError", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    expect(() => store.observe({ counterparty_identity: "", kind: "exchange_success" })).toThrow(
      TypeError,
    );
  });
});

describe("各观察计数", () => {
  it("各观察 kind 累加对应计数；consecutive 在失败时清零", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    store.observe(exchange({ observed_at: T(1) }));
    store.observe({ counterparty_identity: ID, kind: "schema_invalid", observed_at: T(2) });
    store.observe({ counterparty_identity: ID, kind: "timeout", observed_at: T(3) });
    store.observe(exchange({ observed_at: T(4) }));
    store.observe({ counterparty_identity: ID, kind: "signature_failure", observed_at: T(5) });
    store.observe({ counterparty_identity: ID, kind: "replay_detected", observed_at: T(6) });

    const record = store.get(ID)!;
    expect(record.successful_exchanges).toBe(2);
    expect(record.consecutive_verified_exchanges).toBe(0); // signature_failure 清零后 replay 不再累计
    expect(record.invalid_schema_count).toBe(1);
    expect(record.timeout_count).toBe(1);
    expect(record.replay_detected_count).toBe(1);
    expect(record.signature_failure_count).toBe(1);
  });

  it("consecutive 成功累积、失败清零后重新累积", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    for (let i = 1; i <= 3; i++) store.observe(exchange({ observed_at: T(i) }));
    expect(store.get(ID)!.consecutive_verified_exchanges).toBe(3);
    store.observe({ counterparty_identity: ID, kind: "replay_detected", observed_at: T(4) });
    expect(store.get(ID)!.consecutive_verified_exchanges).toBe(0);
    store.observe(exchange({ observed_at: T(5) }));
    expect(store.get(ID)!.consecutive_verified_exchanges).toBe(1);
  });

  it("capability_versions 合并最近观测", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    store.observe(
      exchange({ observed_at: T(1), capability_versions: { negotiate: "1.0", a2a: "1.0" } }),
    );
    store.observe(exchange({ observed_at: T(2), capability_versions: { negotiate: "2.0" } }));
    expect(store.get(ID)!.capability_versions).toEqual({ negotiate: "2.0", a2a: "1.0" });
  });

  it("dispute 观察按 dispute_id 去重；分类缺省 local_asserted", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    store.observe({
      counterparty_identity: ID,
      kind: "dispute",
      observed_at: T(1),
      dispute: { dispute_id: "d-1", reason: "unpaid" },
    });
    store.observe({
      counterparty_identity: ID,
      kind: "dispute",
      observed_at: T(2),
      dispute: { dispute_id: "d-1" },
    });
    expect(store.get(ID)!.local_asserted_disputes).toHaveLength(1);
    expect(store.get(ID)!.local_asserted_disputes[0]!.classification).toBe("local_asserted");
    store.observe({
      counterparty_identity: ID,
      kind: "dispute",
      observed_at: T(3),
      dispute: { dispute_id: "d-2", classification: "third_party_adjudicated" },
    });
    expect(store.get(ID)!.local_asserted_disputes).toHaveLength(2);
  });
});

describe("评估矩阵（升级 / 降级 / 保守取值）", () => {
  it("初始 T0；有成功交换 → T1；连续验签 → T2；已建立关系 → T3", () => {
    const store = new TrustRecordStore({
      dir: freshDir(),
      evaluator: { establishedRelationships: new Set([ID]) },
    });
    store.observe(exchange({ observed_at: T(1) }));
    expect(store.get(ID)!.trust_level).toBe("T3"); // established 优先

    const plain = new TrustRecordStore({ dir: freshDir() });
    plain.observe(exchange({ observed_at: T(1) }));
    expect(plain.get(ID)!.trust_level).toBe("T1");
    plain.observe(exchange({ observed_at: T(2) }));
    expect(plain.get(ID)!.trust_level).toBe("T1");
    plain.observe(exchange({ observed_at: T(3) }));
    expect(plain.get(ID)!.trust_level).toBe("T2");
  });

  it("establishedRelationships（部署配置）移除后 evaluate() 回落", () => {
    const dir = freshDir();
    const established = new TrustRecordStore({
      dir,
      evaluator: { establishedRelationships: new Set([ID]) },
    });
    established.observe(exchange({ observed_at: T(1) }));
    expect(established.get(ID)!.trust_level).toBe("T3");

    const without = new TrustRecordStore({
      dir,
      evaluator: { establishedRelationships: new Set() },
    });
    const result = without.evaluate(ID)!;
    expect(result.evaluation.level).toBe("T1");
    expect(without.get(ID)!.trust_level).toBe("T1");
  });

  it("signature_failure 超阈值 → 拒绝（rejected，T0）", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    store.observe(exchange({ observed_at: T(1) }));
    store.observe({ counterparty_identity: ID, kind: "signature_failure", observed_at: T(2) });
    store.observe({ counterparty_identity: ID, kind: "signature_failure", observed_at: T(3) });
    expect(store.get(ID)!.rejected).toBe(false); // 2 < 3
    store.observe({ counterparty_identity: ID, kind: "signature_failure", observed_at: T(4) });
    const record = store.get(ID)!;
    expect(record.rejected).toBe(true);
    expect(record.trust_level).toBe("T0");
    expect(record.rejection_reason).toContain("signature_failure_count");
  });

  it("replay 超阈值 → 拒绝", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    store.observe({ counterparty_identity: ID, kind: "replay_detected", observed_at: T(1) });
    expect(store.get(ID)!.rejected).toBe(false);
    store.observe({ counterparty_identity: ID, kind: "replay_detected", observed_at: T(2) });
    expect(store.get(ID)!.rejected).toBe(true);
  });

  it("third_party_adjudicated 争议 → 拒绝；local_asserted 不拒绝", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    store.observe({
      counterparty_identity: ID,
      kind: "dispute",
      observed_at: T(1),
      dispute: { dispute_id: "a", classification: "local_asserted" },
    });
    expect(store.get(ID)!.rejected).toBe(false);
    store.observe({
      counterparty_identity: ID,
      kind: "dispute",
      observed_at: T(2),
      dispute: { dispute_id: "b", classification: "third_party_adjudicated" },
    });
    expect(store.get(ID)!.rejected).toBe(true);
  });

  it("降级：T2 后 signature_failure 清连续 → 回落 T1（保守，不直接到 T0）", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    for (let i = 1; i <= 3; i++) store.observe(exchange({ observed_at: T(i) }));
    expect(store.get(ID)!.trust_level).toBe("T2");
    store.observe({ counterparty_identity: ID, kind: "signature_failure", observed_at: T(4) });
    const record = store.get(ID)!;
    expect(record.consecutive_verified_exchanges).toBe(0);
    expect(record.trust_level).toBe("T1"); // 仍有成功交换，但连续性不满足
  });

  it("未解决互认争议封顶 T1；解决后解除封顶", () => {
    const dir = freshDir();
    const store = new TrustRecordStore({
      dir,
      evaluator: { establishedRelationships: new Set([ID]) },
    });
    store.observe(exchange({ observed_at: T(1) }));
    expect(store.get(ID)!.trust_level).toBe("T3");

    store.observe({
      counterparty_identity: ID,
      kind: "dispute",
      observed_at: T(2),
      dispute: { dispute_id: "m", classification: "mutually_acknowledged" },
    });
    expect(store.get(ID)!.trust_level).toBe("T1");

    // 同一 dispute 重新观察并标记已解决 → 不再封顶。
    store.observe({
      counterparty_identity: ID,
      kind: "dispute",
      observed_at: T(3),
      dispute: { dispute_id: "m", classification: "mutually_acknowledged", resolved: true },
    });
    expect(store.get(ID)!.local_asserted_disputes).toHaveLength(1); // 更新而非追加
    expect(store.get(ID)!.trust_level).toBe("T3");
  });

  it("未解决本地争议封顶 T2", () => {
    const store = new TrustRecordStore({
      dir: freshDir(),
      evaluator: { establishedRelationships: new Set([ID]) },
    });
    store.observe(exchange({ observed_at: T(1) }));
    expect(store.get(ID)!.trust_level).toBe("T3");
    store.observe({
      counterparty_identity: ID,
      kind: "dispute",
      observed_at: T(2),
      dispute: { dispute_id: "l", classification: "local_asserted" },
    });
    expect(store.get(ID)!.trust_level).toBe("T2");
  });

  it("自定义阈值：连续验签 ≥ 2 → T2", () => {
    const store = new TrustRecordStore({
      dir: freshDir(),
      evaluator: { config: { ...DEFAULT_TRUST_EVALUATOR_CONFIG, consecutiveVerifiedToT2: 2 } },
    });
    store.observe(exchange({ observed_at: T(1) }));
    expect(store.get(ID)!.trust_level).toBe("T1");
    store.observe(exchange({ observed_at: T(2) }));
    expect(store.get(ID)!.trust_level).toBe("T2");
  });
});

describe("Reputation unknown 语义（§27：绝不 0.5）", () => {
  it("无 reputation 来源 → 显式 unknown", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    const result = store.observe(exchange());
    expect(result.evaluation.reputation).toEqual({ status: "unknown" });
  });

  it("evaluateTrustRecord 直调同样返回 unknown，不是 0.5", () => {
    const result = evaluateTrustRecord(facts({ successful_exchanges: 2 }));
    expect(result.reputation).toEqual({ status: "unknown" });
  });

  it("有来源时透传 known 分数", () => {
    const source: ReputationSource = { score: () => ({ status: "known", score: 0.8 }) };
    const result = evaluateTrustRecord(facts({ successful_exchanges: 2 }), { reputation: source });
    expect(result.reputation).toEqual({ status: "known", score: 0.8 });
    expect(result.level).toBe("T1"); // reputation 不改变协议 level（§27/§28 分离）
  });
});

describe("Agent Card 指纹变更检测", () => {
  it("首次建立指纹不告警；变更产生告警信号并持久化计数", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    const first = store.observe(exchange({ observed_at: T(1), agent_card_fingerprint: FP_A }));
    expect(first.fingerprintChanged).toBe(false);

    const second = store.observe(exchange({ observed_at: T(2), agent_card_fingerprint: FP_B }));
    expect(second.fingerprintChanged).toBe(true);
    expect(second.previousFingerprint).toBe(FP_A);
    expect(second.currentFingerprint).toBe(FP_B);

    const record = store.get(ID)!;
    expect(record.fingerprint_changes).toBe(1);
    expect(record.agent_card_fingerprint).toBe(FP_B);
    expect(record.last_fingerprint_change_at).toBe(T(2));
  });

  it("指纹变更清空验签连续性（先验身份锚失效），不静默接受", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    for (let i = 1; i <= 3; i++) {
      store.observe(exchange({ observed_at: T(i), agent_card_fingerprint: FP_A }));
    }
    expect(store.get(ID)!.consecutive_verified_exchanges).toBe(3);
    expect(store.get(ID)!.trust_level).toBe("T2");

    store.observe(exchange({ observed_at: T(4), agent_card_fingerprint: FP_B }));
    const record = store.get(ID)!;
    expect(record.fingerprint_changes).toBe(1);
    expect(record.consecutive_verified_exchanges).toBe(1); // 清零后本次成功 +1
    expect(record.trust_level).toBe("T1");
  });

  it("指纹变更告警跨重启仍可发现（持久化计数）", () => {
    const dir = freshDir();
    const store = new TrustRecordStore({ dir });
    store.observe(exchange({ observed_at: T(1), agent_card_fingerprint: FP_A }));
    store.observe(exchange({ observed_at: T(2), agent_card_fingerprint: FP_B }));

    const restored = new TrustRecordStore({ dir });
    const record = restored.get(ID)!;
    expect(record.fingerprint_changes).toBe(1);
    expect(record.agent_card_fingerprint).toBe(FP_B);
    expect(record.last_fingerprint_change_at).toBe(T(2));
  });

  it("指纹对 identity 承载字段稳定：接口顺序变化不触发假变更", () => {
    const a = computeAgentCardFingerprint({
      name: "Acme",
      supportedInterfaces: [
        { url: "https://a.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: "https://b.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
    });
    const b = computeAgentCardFingerprint({
      name: "Acme",
      supportedInterfaces: [
        { url: "https://b.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: "https://a.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
    });
    expect(a).toBe(b);
  });
});

describe("TrustPolicy 集成（evaluatePolicy 读取 record）", () => {
  it("record.rejected → evaluatePolicy 直接拒绝（fail-closed）", () => {
    const result = evaluatePolicy(DEFAULT_TRUST_POLICY, {
      level: "T0",
      hasHttpSignature: false,
      hasCardJws: false,
      record: { trustLevel: "T0", rejected: true },
    });
    expect(result).toMatchObject({ allowed: false, protocolCode: "authorization_failed" });
  });

  it("密钥档案 level 与 record 冲突时取更保守者", () => {
    // 档案 T2，record T0 → 有效 T0（不强制签名）
    expect(
      evaluatePolicy(DEFAULT_TRUST_POLICY, {
        level: "T2",
        hasHttpSignature: false,
        hasCardJws: false,
        record: { trustLevel: "T0" },
      }).allowed,
    ).toBe(true);

    // 档案 T0，record T2 → 有效 T0
    expect(
      evaluatePolicy(DEFAULT_TRUST_POLICY, {
        level: "T0",
        hasHttpSignature: false,
        hasCardJws: false,
        record: { trustLevel: "T2" },
      }).allowed,
    ).toBe(true);

    // 档案 T2，record T1 → 有效 T1：强制签名但不强制 JWS
    const result = evaluatePolicy(DEFAULT_TRUST_POLICY, {
      level: "T2",
      hasHttpSignature: false,
      hasCardJws: false,
      record: { trustLevel: "T1" },
    });
    expect(result).toMatchObject({
      allowed: false,
      protocolCode: "authentication_required",
      missing: ["http-signature"],
    });
  });

  it("recordPolicyInput 把 record 转成 evaluatePolicy 输入", () => {
    const store = new TrustRecordStore({ dir: freshDir() });
    store.observe({ counterparty_identity: ID, kind: "signature_failure", observed_at: T(1) });
    store.observe({ counterparty_identity: ID, kind: "signature_failure", observed_at: T(2) });
    store.observe({ counterparty_identity: ID, kind: "signature_failure", observed_at: T(3) });
    const input = recordPolicyInput(store.get(ID)!);
    expect(input).toEqual({ trustLevel: "T0", rejected: true });
    const result = evaluatePolicy(DEFAULT_TRUST_POLICY, {
      level: "T2",
      hasHttpSignature: true,
      hasCardJws: true,
      record: input,
    });
    expect(result).toMatchObject({ allowed: false, protocolCode: "authorization_failed" });
  });

  it("conservativeLevel 单测", () => {
    expect(conservativeLevel("T0", "T3")).toBe("T0");
    expect(conservativeLevel("T3", "T0")).toBe("T0");
    expect(conservativeLevel("T2", "T1")).toBe("T1");
    expect(conservativeLevel("T2", "T2")).toBe("T2");
  });
});
