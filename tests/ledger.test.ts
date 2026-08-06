/**
 * Negotiation Ledger tests（基线 §22 / §23 / 子规范 §28）：
 *  - hash 链：创世、previous_event_digest 链接、断链（chain_break）与篡改
 *    （tampered）可区分检测；坏行 corrupt；链内重复 digest duplicate。
 *  - append-only：向已破坏的链 append 拒绝（ledger_append_only_violation）；
 *    重复内容 append 拒绝（ledger_duplicate_content，内容寻址去重）。
 *  - 查询：events 序列、highWaterMark、findByMessageId（§23 恢复用）。
 *  - 本地持久化：目录 0700、文件 0600。
 *  - 不保存 raw chain-of-thought / Vault plaintext（负向测试，§22/§28/§36-5）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentDigest } from "../src/negotiation/jcs.js";
import { LedgerError, LedgerStore, ledgerFileName } from "../src/negotiation/ledger/index.js";
import type { LedgerEventContent } from "../src/negotiation/ledger/index.js";

const NEG = "neg_01H5V8KXZqJ7Qp3mN2B6A";
const NEG_2 = "neg_02H5V8KXZqJ7Qp3mN2B6A";
const MESSAGE_A = "msg_01H5V8KXZqJ7Qp3mN2B6A";
const MESSAGE_B = "msg_02H5V8KXZqJ7Qp3mN2B6A";
const MESSAGE_C = "msg_03H5V8KXZqJ7Qp3mN2B6A";
const SENDER = "buyer@kiwi.test";
const COUNTERPARTY = "merchant@kiwi.test";
const CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";
const T0 = "2026-08-05T12:00:00Z";

function baseContent(overrides: Partial<LedgerEventContent> = {}): LedgerEventContent {
  return {
    event_kind: "message_received",
    negotiation_id: NEG,
    message_id: MESSAGE_A,
    identity: { sender_identity: SENDER, counterparty_identity: COUNTERPARTY, actor: "buyer" },
    capability: { capability: CAPABILITY, protocol_version: "1.0" },
    wire_digest: contentDigest({ action: "rfq", message_id: MESSAGE_A }),
    outcome: { kind: "ok", result: { accepted: true } },
    occurred_at: T0,
    ...overrides,
  };
}

/** 直接改写链文件（模拟外部篡改/删除）。 */
function ledgerFilePath(dir: string, negotiationId = NEG): string {
  return path.join(dir, "ledger", ledgerFileName(negotiationId));
}

function fileLines(filePath: string): string[] {
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof LedgerError ? e.code : `unexpected:${String(e)}`;
  }
}

describe("Negotiation Ledger: hash 链", () => {
  let dir: string;
  let store: LedgerStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-"));
    store = new LedgerStore({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("创世事件 previous_event_digest 为 null，后续事件链接链尾", () => {
    const first = store.append(baseContent({ message_id: MESSAGE_A }));
    const second = store.append(baseContent({ message_id: MESSAGE_B }));

    expect(first.previous_event_digest).toBeNull();
    expect(second.previous_event_digest).toBe(first.event_digest);
    expect(first.event_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(store.events(NEG)).toHaveLength(2);
    expect(store.verifyChain(NEG)).toEqual({ valid: true, count: 2 });
  });

  it("空链（无事件）视为 valid", () => {
    expect(store.verifyChain(NEG)).toEqual({ valid: true, count: 0 });
  });

  it("断链检测：中间事件被删除 → chain_break 且 append 被拒", () => {
    store.append(baseContent({ message_id: MESSAGE_A }));
    store.append(baseContent({ message_id: MESSAGE_B }));
    store.append(baseContent({ message_id: MESSAGE_C }));

    // 删除中间一条（模拟外部删改）。
    const filePath = ledgerFilePath(dir);
    const lines = fileLines(filePath);
    writeFileSync(filePath, `${lines[0]}\n${lines[2] ?? ""}\n`, "utf-8");

    const result = store.verifyChain(NEG);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("chain_break");
    expect(result.error?.index).toBe(1);

    // append-only：已破坏的链拒绝继续 append（fail-closed，不修补）。
    expect(
      errorCode(() => store.append(baseContent({ message_id: MESSAGE_C, occurred_at: T0 }))),
    ).toBe("ledger_append_only_violation");
  });

  it("篡改检测：事件内容被改 → tampered", () => {
    const first = store.append(baseContent({ message_id: MESSAGE_A }));
    store.append(baseContent({ message_id: MESSAGE_B }));

    // 把第一条 outcome 改掉，保留原 digest（外部篡改后未重算）。
    const filePath = ledgerFilePath(dir);
    const lines = fileLines(filePath);
    const tampered = JSON.parse(lines[0] ?? "{}");
    tampered.outcome = { kind: "ok", result: { accepted: false } };
    writeFileSync(filePath, `${JSON.stringify(tampered)}\n${lines[1] ?? ""}\n`, "utf-8");

    const result = store.verifyChain(NEG);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("tampered");
    expect(result.error?.index).toBe(0);
    expect(result.error?.detail).toContain(first.event_digest);
  });

  it("坏行检测：非 JSON 行 → corrupt", () => {
    store.append(baseContent({ message_id: MESSAGE_A }));
    const filePath = ledgerFilePath(dir);
    writeFileSync(filePath, `${fileLines(filePath)[0] ?? ""}\n{ torn append\n`, "utf-8");

    const result = store.verifyChain(NEG);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("corrupt");
  });

  it("重复 digest 检测：链内同 event_digest 出现两次 → duplicate", () => {
    // 用 store append 一条（内容 X），再手工构造「同内容、链接正确」的第二条：
    // event_digest 不含 previous_event_digest，因此同内容的第二条 digest 相同，
    // 链接却能对上 —— 这是唯一能触发 duplicate 判定（而非 chain_break）的篡改形态。
    const first = store.append(baseContent({ message_id: MESSAGE_A }));
    const filePath = ledgerFilePath(dir);
    const firstParsed = JSON.parse(fileLines(filePath)[0] ?? "{}") as {
      event_id: string;
      event_digest: string;
    };
    const duplicate = {
      ...JSON.parse(fileLines(filePath)[0] ?? "{}"),
      event_id: "evt_duplicate",
      previous_event_digest: first.event_digest,
    };
    writeFileSync(
      filePath,
      `${JSON.stringify(firstParsed)}\n${JSON.stringify(duplicate)}\n`,
      "utf-8",
    );

    const result = store.verifyChain(NEG);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("duplicate");
    expect(result.error?.index).toBe(1);
  });
});

describe("Negotiation Ledger: append-only 与内容寻址", () => {
  let dir: string;
  let store: LedgerStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-"));
    store = new LedgerStore({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("内容寻址：同一稳定内容 append 两次 → ledger_duplicate_content", () => {
    store.append(baseContent());
    expect(errorCode(() => store.append(baseContent()))).toBe("ledger_duplicate_content");
    expect(store.events(NEG)).toHaveLength(1);
  });

  it("内容寻址查询：findEventByDigest 按 event_digest 取事件", () => {
    const first = store.append(baseContent({ message_id: MESSAGE_A }));
    const found = store.findEventByDigest(NEG, first.event_digest);
    expect(found?.event_id).toBe(first.event_id);
    expect(store.findEventByDigest(NEG, "sha256:" + "0".repeat(64))).toBeNull();
  });

  it("不同 message_id → 不同 event_digest（内容寻址包含业务字段）", () => {
    const a = store.append(baseContent({ message_id: MESSAGE_A }));
    const b = store.append(baseContent({ message_id: MESSAGE_B }));
    expect(a.event_digest).not.toBe(b.event_digest);
  });

  it("不可变：没有任何 update/delete 语义，序列保持追加顺序", () => {
    const a = store.append(baseContent({ message_id: MESSAGE_A }));
    const b = store.append(baseContent({ message_id: MESSAGE_B }));
    const c = store.append(baseContent({ message_id: MESSAGE_C, occurred_at: T0 }));
    expect(store.events(NEG).map((e) => e.event_id)).toEqual([a.event_id, b.event_id, c.event_id]);
  });
});

describe("Negotiation Ledger: 查询能力（§23 Recovery）", () => {
  let dir: string;
  let store: LedgerStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-"));
    store = new LedgerStore({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("highWaterMark：count / last_event_digest / last_message_id", () => {
    const first = store.append(baseContent({ message_id: MESSAGE_A }));
    const second = store.append(baseContent({ message_id: MESSAGE_B }));

    const mark = store.highWaterMark(NEG);
    expect(mark.count).toBe(2);
    expect(mark.last_event_digest).toBe(second.event_digest);
    expect(mark.last_event_id).toBe(second.event_id);
    expect(mark.last_message_id).toBe(MESSAGE_B);
    void first;
  });

  it("findByMessageId：跨 negotiation 按 message_id 查重（比较 acknowledged messages）", () => {
    store.append(baseContent({ negotiation_id: NEG, message_id: MESSAGE_A }));
    store.append(baseContent({ negotiation_id: NEG_2, message_id: MESSAGE_B }));

    const hit = store.findByMessageId(MESSAGE_B);
    expect(hit?.negotiation_id).toBe(NEG_2);
    expect(hit?.event.message_id).toBe(MESSAGE_B);
    expect(store.findByMessageId("msg_999")).toBeNull();
  });

  it("listNegotiations 列出已落账的 negotiation_id", () => {
    store.append(baseContent({ negotiation_id: NEG, message_id: MESSAGE_A }));
    store.append(baseContent({ negotiation_id: NEG_2, message_id: MESSAGE_B }));
    expect(store.listNegotiations().sort()).toEqual([NEG, NEG_2].sort());
  });
});

describe("Negotiation Ledger: 本地持久化与权限", () => {
  let dir: string;
  let store: LedgerStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-"));
    store = new LedgerStore({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("目录 0700、文件 0600（WP0 L2 基线）", () => {
    store.append(baseContent({ message_id: MESSAGE_A }));

    const ledgerDirMode = statSync(path.join(dir, "ledger")).mode & 0o777;
    const fileMode = statSync(ledgerFilePath(dir)).mode & 0o777;
    expect(ledgerDirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("重开 store 后（模拟重启）事件可读、链仍有效", () => {
    const first = store.append(baseContent({ message_id: MESSAGE_A }));
    const second = store.append(baseContent({ message_id: MESSAGE_B }));

    const reopened = new LedgerStore({ dir });
    expect(reopened.events(NEG).map((e) => e.event_id)).toEqual([first.event_id, second.event_id]);
    expect(reopened.verifyChain(NEG).valid).toBe(true);
  });

  it("文件名安全：含路径分隔符的 negotiation_id 不逃逸 ledger 目录", () => {
    const evil = "../../escape";
    store.append(baseContent({ negotiation_id: evil, message_id: MESSAGE_A }));
    expect(store.events(evil)).toHaveLength(1);
    // 目录内没有向上逃逸产生的文件。
    expect(fileLines(path.join(dir, "ledger", ledgerFileName(evil)))).toHaveLength(1);
  });
});

describe("Negotiation Ledger: 不保存 CoT / Vault plaintext（负向）", () => {
  let dir: string;
  let store: LedgerStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-"));
    store = new LedgerStore({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("outcome.result 带 chain_of_thought → ledger_forbidden_content，且不落盘", () => {
    expect(
      errorCode(() =>
        store.append(
          baseContent({
            message_id: MESSAGE_A,
            outcome: {
              kind: "ok",
              result: { accepted: true, chain_of_thought: "internal reasoning text" },
            },
          }),
        ),
      ),
    ).toBe("ledger_forbidden_content");
    expect(store.events(NEG)).toHaveLength(0);
  });

  it("wire_payload 带 vault_plaintext → ledger_forbidden_content", () => {
    expect(
      errorCode(() =>
        store.append(
          baseContent({
            message_id: MESSAGE_A,
            wire_payload: { action: "rfq", vault_plaintext: { balance: 123 } },
          }),
        ),
      ),
    ).toBe("ledger_forbidden_content");
  });

  it("嵌套 reasoning / secret 同样被拒绝（递归扫描）", () => {
    // outcome 类型是封闭的（§22 不保存 CoT），用类型逃生舱把 reasoning 塞进去，
    // 验证运行时守卫同样 fail-closed。
    const smuggled = baseContent({
      message_id: MESSAGE_A,
      outcome: { kind: "error", code: "state_conflict", message: "bad" },
    }) as unknown as LedgerEventContent;
    (smuggled.outcome as Record<string, unknown>).reasoning = "deep chain";
    expect(errorCode(() => store.append(smuggled))).toBe("ledger_forbidden_content");
    expect(
      errorCode(() =>
        store.append(
          baseContent({
            message_id: MESSAGE_A,
            wire_payload: { nested: { credentials: { token: "sk-abc" } } },
          }),
        ),
      ),
    ).toBe("ledger_forbidden_content");
  });

  it("合法内容（无禁词）正常落账", () => {
    const event = store.append(
      baseContent({ message_id: MESSAGE_A, outcome: { kind: "ok", result: { accepted: true } } }),
    );
    expect(store.events(NEG)[0]?.event_id).toBe(event.event_id);
  });

  it("目录权限的负向基线：chmod 演示 umask 无关性（chmodSync 后仍是 0600）", () => {
    store.append(baseContent({ message_id: MESSAGE_A }));
    const filePath = ledgerFilePath(dir);
    chmodSync(filePath, 0o644);
    store.append(baseContent({ message_id: MESSAGE_B })); // append 重写后恢复 0600
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
});
