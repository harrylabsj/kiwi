/**
 * M4 审批到期闭环（§17.1/§17.2）与 M0 冻结配置：
 *  - sweepExpired 持久化 pending/approved → expired，重复扫描幂等；
 *  - 等于 deadline 归过期侧；只失效，不自动批准/拒绝；
 *  - 配置非法时回退默认值，不静默改变业务边界。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RECEPTION_CONFIG_DEFAULTS,
  loadReceptionConfig,
} from "../src/a2a/reception/config.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";

describe("approval expiry sweep", () => {
  let dir: string;
  let clock: string;
  let store: NegotiationApprovalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-approval-sweep-"));
    clock = "2026-11-03T04:00:00.000Z";
    store = new NegotiationApprovalStore(dir, () => clock);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pending = (ttl?: number) =>
    store.recordPending({
      negotiation_id: "ctx_1",
      sku: "VQ-001",
      currency: "CNY",
      quantity: 1,
      buyer_offer_minor: 10_000,
      ...(ttl !== undefined ? { ttl_seconds: ttl } : {}),
    });

  it("到期前的 pending 不被扫描掉", () => {
    pending(900);
    clock = "2026-11-03T04:14:59.000Z";
    expect(store.sweepExpired()).toHaveLength(0);
    expect(store.list("pending")).toHaveLength(1);
  });

  it("等于 deadline 归过期侧，并持久化状态", () => {
    const record = pending(900);
    clock = "2026-11-03T04:15:00.000Z";
    const changed = store.sweepExpired();
    expect(changed).toHaveLength(1);
    expect(changed[0]?.approval_id).toBe(record.approval_id);
    expect(changed[0]?.status).toBe("expired");
    // 重复扫描幂等。
    expect(store.sweepExpired()).toHaveLength(0);
    const file = JSON.parse(
      readFileSync(join(dir, "negotiation-approvals.json"), "utf8"),
    ) as { records: Array<{ approval_id: string; status: string; updated_at: string }> };
    const stored = file.records.find((item) => item.approval_id === record.approval_id);
    expect(stored?.status).toBe("expired");
    expect(stored?.updated_at).toBe(clock);
  });

  it("已批准但未消费的授权到期也置 expired", () => {
    const record = pending(900);
    store.approve({ approval_id: record.approval_id, approved_minor: 10_500, ttl_seconds: 60 });
    clock = "2026-11-03T04:16:01.000Z";
    const changed = store.sweepExpired();
    expect(changed).toHaveLength(1);
    expect(changed[0]?.status).toBe("expired");
    expect(store.consume({ negotiation_id: "ctx_1", sku: "VQ-001" })).toBeUndefined();
  });

  it("没有 expires_at 的 pending 不按时间扫描", () => {
    pending();
    clock = "2026-12-31T00:00:00.000Z";
    expect(store.sweepExpired()).toHaveLength(0);
    expect(store.list("pending")).toHaveLength(1);
  });
});

describe("reception M0 config", () => {
  it("默认值与 D07/D08/D10 冻结值一致", () => {
    const config = loadReceptionConfig({});
    expect(config).toMatchObject({
      mode: "off",
      locale: "zh-CN",
      currency: "CNY",
      dailyOutputTokenLimit: 200_000,
      runDeadlineMs: 30_000,
      maxModelTurns: 6,
      maxToolAttempts: 12,
      approvalTtlSeconds: 900,
      retentionDays: 30,
      contactRetentionDays: 7,
      usageRetentionDays: 90,
    });
    expect(RECEPTION_CONFIG_DEFAULTS.attemptReserveTokens).toBe(2_048);
  });

  it("合法环境变量覆盖数值，非法值回退默认", () => {
    const configured = loadReceptionConfig({
      KIWI_MERCHANT_RECEPTION: "active",
      KIWI_RECEPTION_DAILY_TOKEN_LIMIT: "50000",
      KIWI_RECEPTION_APPROVAL_TTL_SECONDS: "600",
    });
    expect(configured.mode).toBe("active");
    expect(configured.dailyOutputTokenLimit).toBe(50_000);
    expect(configured.approvalTtlSeconds).toBe(600);

    const invalid = loadReceptionConfig({
      KIWI_MERCHANT_RECEPTION: "yes",
      KIWI_RECEPTION_DAILY_TOKEN_LIMIT: "0",
      KIWI_RECEPTION_APPROVAL_TTL_SECONDS: "soon",
    });
    expect(invalid.mode).toBe("off");
    expect(invalid.dailyOutputTokenLimit).toBe(200_000);
    expect(invalid.approvalTtlSeconds).toBe(900);
  });
});
