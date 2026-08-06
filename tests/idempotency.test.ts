/**
 * 协议级幂等 tests（基线 §17 / 子规范 §20 Idempotency and Replay）：
 *  - 三态判定：new / replayed（同 key 同 digest）/ conflict（同 key 异 digest）；
 *  - conflict fail-closed：绝不应用新 payload，commit 与 check 双保险；
 *  - retention：24h 地板 + offer_valid_until / task_lifetime_until 上推，
 *    sweep 过期清理，过期记录视同「新消息」；
 *  - 与 Ledger 的关系：判定证据落 Ledger（ledger_event_id / ledger_event_digest 引用）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentDigest } from "../src/negotiation/jcs.js";
import {
  IDEMPOTENCY_FLOOR_MS,
  IdempotencyConflictError,
  IdempotencyStore,
  computeRetentionDeadline,
} from "../src/negotiation/idempotency/index.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";

const SENDER = "buyer@kiwi.test";
const MESSAGE_ID = "msg_01H5V8KXZqJ7Qp3mN2B6A";
const NEG = "neg_01H5V8KXZqJ7Qp3mN2B6A";
const DIGEST_A = contentDigest({ action: "rfq", message_id: MESSAGE_ID });
const DIGEST_B = contentDigest({ action: "offer", message_id: MESSAGE_ID });

describe("协议级幂等：三态判定（§20.1–§20.3）", () => {
  let dir: string;
  let store: IdempotencyStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kiwi-idem-"));
    store = new IdempotencyStore({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("新 key → new", () => {
    const decision = store.check({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
    });
    expect(decision).toEqual({ status: "new", key: expect.any(String) });
  });

  it("同 key 同 digest → replayed，返回原结果（不重复执行）", () => {
    store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok", result: { accepted: true } },
    });

    const decision = store.check({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
    });
    expect(decision.status).toBe("replayed");
    if (decision.status === "replayed") {
      expect(decision.record.digest).toBe(DIGEST_A);
      expect(decision.record.outcome).toEqual({ kind: "ok", result: { accepted: true } });
    }
  });

  it("同 key 异 digest → conflict，fail-closed", () => {
    store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok", result: { accepted: true } },
    });

    const decision = store.check({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_B,
    });
    expect(decision.status).toBe("conflict");
    if (decision.status === "conflict") {
      expect(decision.record.digest).toBe(DIGEST_A);
    }
  });

  it("commit 异 digest → IdempotencyConflictError（check/commit 之间并发兜底）", () => {
    store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok" },
    });

    expect(() =>
      store.commit({
        sender_identity: SENDER,
        message_id: MESSAGE_ID,
        digest: DIGEST_B,
        negotiation_id: NEG,
        outcome: { kind: "ok", result: { applied: false } },
      }),
    ).toThrow(IdempotencyConflictError);
    // 记录未被覆盖：原 digest 保留。
    expect(store.get(SENDER, MESSAGE_ID)?.digest).toBe(DIGEST_A);
  });

  it("commit 同 digest 再次提交 → 幂等返回既有记录", () => {
    const first = store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok", result: { accepted: true } },
    });
    const second = store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok", result: { accepted: true } },
    });
    expect(second).toEqual(first);
  });

  it("幂等键区分不同 sender：同 message_id 异 sender 视为新消息", () => {
    store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok" },
    });
    const decision = store.check({
      sender_identity: "merchant@kiwi.test",
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
    });
    expect(decision.status).toBe("new");
  });
});

describe("协议级幂等：retention（§20.5 / 基线 §17）", () => {
  let dir: string;
  let clock: { iso: string };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kiwi-idem-"));
    clock = { iso: "2026-08-06T00:00:00.000Z" };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeStore(): IdempotencyStore {
    return new IdempotencyStore({ dir, now: () => clock.iso });
  }

  function advanceHours(hours: number): void {
    clock.iso = new Date(Date.parse(clock.iso) + hours * 60 * 60 * 1000).toISOString();
  }

  it("computeRetentionDeadline 地板 24h，offer/task 时限上推", () => {
    const now = new Date(clock.iso);
    expect(computeRetentionDeadline(now)).toEqual(new Date(now.getTime() + IDEMPOTENCY_FLOOR_MS));

    const farOffer = "2026-09-01T00:00:00.000Z";
    expect(computeRetentionDeadline(now, { offer_valid_until: farOffer }).toISOString()).toBe(
      farOffer,
    );

    const taskUntil = "2026-08-10T00:00:00.000Z";
    expect(computeRetentionDeadline(now, { task_lifetime_until: taskUntil }).toISOString()).toBe(
      taskUntil,
    );

    // 过去/无效时限不压过地板。
    expect(
      computeRetentionDeadline(now, { offer_valid_until: "2020-01-01T00:00:00.000Z" }),
    ).toEqual(new Date(now.getTime() + IDEMPOTENCY_FLOOR_MS));
  });

  it("过期记录被 sweep 清理，清理后视同新消息", () => {
    const store = makeStore();
    store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok" },
    });
    expect(store.count()).toBe(1);

    advanceHours(25); // 超过 24h 地板
    expect(store.sweep()).toBe(1);
    expect(store.count()).toBe(0);
    expect(store.get(SENDER, MESSAGE_ID)).toBeNull();
    expect(
      store.check({ sender_identity: SENDER, message_id: MESSAGE_ID, digest: DIGEST_A }),
    ).toEqual({ status: "new", key: expect.any(String) });
  });

  it("未过期记录 sweep 不清除；check 命中 replayed", () => {
    const store = makeStore();
    store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok" },
    });
    advanceHours(10);
    expect(store.sweep()).toBe(0);
    expect(
      store.check({ sender_identity: SENDER, message_id: MESSAGE_ID, digest: DIGEST_A }).status,
    ).toBe("replayed");
  });

  it("offer 有效期内不过期：valid_until 上推覆盖 24h 地板", () => {
    const store = makeStore();
    store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok" },
      retention: { offer_valid_until: "2026-08-20T00:00:00.000Z" },
    });
    expect(store.get(SENDER, MESSAGE_ID)?.expires_at).toBe("2026-08-20T00:00:00.000Z");

    advanceHours(48);
    expect(store.sweep()).toBe(0); // 仍在 offer 有效期内
    expect(
      store.check({ sender_identity: SENDER, message_id: MESSAGE_ID, digest: DIGEST_A }).status,
    ).toBe("replayed");
  });
});

describe("协议级幂等：本地持久化与 Ledger 关系", () => {
  let dir: string;
  let store: IdempotencyStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kiwi-idem-"));
    store = new IdempotencyStore({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("目录 0700、文件 0600", () => {
    store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok" },
    });

    const indexDirMode = statSync(path.join(dir, "idempotency")).mode & 0o777;
    expect(indexDirMode).toBe(0o700);

    const files = readdirSync(path.join(dir, "idempotency"));
    expect(files).toHaveLength(1);
    expect(files[0] ?? "").toMatch(/^idem-[0-9a-f]{64}\.json$/);
    const fileMode = statSync(path.join(dir, "idempotency", files[0] ?? "")).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });

  it("重开 store（模拟重启）记录仍可读", () => {
    store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok", result: { accepted: true } },
    });

    const reopened = new IdempotencyStore({ dir });
    const decision = reopened.check({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
    });
    expect(decision.status).toBe("replayed");
  });

  it("判定证据落 Ledger：record 引用 ledger_event_id / ledger_event_digest", () => {
    // 1. 幂等 commit 时先落 Ledger 事件，再把证据引用写进幂等记录。
    const ledger = new LedgerStore({ dir });
    const ledgerEvent = ledger.append({
      event_kind: "message_received",
      negotiation_id: NEG,
      message_id: MESSAGE_ID,
      identity: {
        sender_identity: SENDER,
        counterparty_identity: "merchant@kiwi.test",
        actor: "buyer",
      },
      capability: { capability: "example.kiwi.shopping.negotiation", protocol_version: "1.0" },
      wire_digest: DIGEST_A,
      outcome: { kind: "ok", result: { accepted: true } },
      occurred_at: "2026-08-05T12:00:00Z",
    });

    const record = store.commit({
      sender_identity: SENDER,
      message_id: MESSAGE_ID,
      digest: DIGEST_A,
      negotiation_id: NEG,
      outcome: { kind: "ok", result: { accepted: true } },
      ledger_event_id: ledgerEvent.event_id,
      ledger_event_digest: ledgerEvent.event_digest,
    });

    expect(record.ledger_event_id).toBe(ledgerEvent.event_id);
    expect(record.ledger_event_digest).toBe(ledgerEvent.event_digest);
    expect(record.digest).toBe(DIGEST_A);
    // Ledger 链完整，且 wire_digest 与幂等 digest 一致 —— 判定证据可交叉验证。
    expect(ledger.verifyChain(NEG).valid).toBe(true);
    expect(ledger.findByMessageId(MESSAGE_ID)?.event.wire_digest).toBe(DIGEST_A);
  });
});

describe("协议级幂等：权限负向基线", () => {
  it("文件权限不继承宽松目录：新记录仍 0600，目录再次访问恢复 0700", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-idem-"));
    try {
      const store = new IdempotencyStore({ dir });
      store.commit({
        sender_identity: SENDER,
        message_id: MESSAGE_ID,
        digest: DIGEST_A,
        negotiation_id: NEG,
        outcome: { kind: "ok" },
      });
      const files = readdirSync(path.join(dir, "idempotency"));
      const firstPath = path.join(dir, "idempotency", files[0] ?? "");

      // 模拟外部把旧文件/目录权限改宽。
      chmodSync(firstPath, 0o644);
      chmodSync(path.join(dir, "idempotency"), 0o755);

      // 新 key 的提交是全新创建（openSync wx 0600），不继承目录/旧文件权限。
      store.commit({
        sender_identity: SENDER,
        message_id: "msg_02H5V8KXZqJ7Qp3mN2B6A",
        digest: contentDigest({ m: 2 }),
        negotiation_id: NEG,
        outcome: { kind: "ok" },
      });

      const filesAfter = readdirSync(path.join(dir, "idempotency"));
      expect(filesAfter).toHaveLength(2);
      const newPath = filesAfter.find((f) => f !== files[0]);
      expect(statSync(path.join(dir, "idempotency", newPath ?? "")).mode & 0o777).toBe(0o600);
      // 目录访问时自愈回 0700。
      expect(statSync(path.join(dir, "idempotency")).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
