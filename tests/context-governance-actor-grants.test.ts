/**
 * TOP1-3 M1：ActorContext 服务端创建/校验 + DataUseGrant 生命周期。
 * 用途分开、epoch 递增、过期、撤销 CAS、跨商家/跨主体隔离。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import {
  createActorContext,
  hasCapability,
  requireCapability,
} from "../src/merchant-core/context-governance/actor-context.js";
import { DataUseGrantStore } from "../src/merchant-core/context-governance/data-use-grant.js";
import {
  ContextGovernanceError,
  GOVERNANCE_POLICY_VERSION,
} from "../src/merchant-core/context-governance/types.js";

const NOW = "2026-11-15T00:00:00.000Z";
const LATER = "2026-12-15T00:00:00.000Z";

describe("ActorContext（设计 §4.1）", () => {
  it("服务端创建成功；能力去重并按注册表排序", () => {
    const actor = createActorContext({
      merchant_id: "m-1",
      actor_id: "admin-1",
      auth_strength: "verified",
      subject_binding: "organization",
      capabilities: ["memory:write", "memory:read", "memory:write"],
    });
    expect(actor.merchant_id).toBe("m-1");
    expect(actor.capabilities).toEqual(["memory:read", "memory:write"]);
    expect(actor.policy_version).toBe(GOVERNANCE_POLICY_VERSION);
    expect(hasCapability(actor, "memory:read")).toBe(true);
    expect(() => requireCapability(actor, "jobs:manage")).toThrowError(ContextGovernanceError);
  });

  it("模型/客户端不能注入可信字段之外的能力：未知能力拒绝", () => {
    expect(() =>
      createActorContext({
        merchant_id: "m-1",
        actor_id: "a-1",
        auth_strength: "verified",
        subject_binding: "none",
        capabilities: ["*"],
      }),
    ).toThrowError(ContextGovernanceError);
  });

  it("D-M0-01：person / verified_person 主体一律拒绝，保留接入点", () => {
    for (const binding of ["person", "verified_person"] as const) {
      try {
        createActorContext({
          merchant_id: "m-1",
          actor_id: "a-1",
          auth_strength: "verified",
          subject_binding: binding,
          capabilities: ["memory:read"],
        });
        expect.unreachable(`${binding} 应被拒绝`);
      } catch (err) {
        const e = err as ContextGovernanceError;
        expect(e.code).toBe("unsupported_capability");
        expect(e.reason).toBe("subject_binding_rejected");
      }
    }
  });

  it("形状校验：空/超长/控制字符 ID、匿名绑定、未知枚举都拒绝", () => {
    const base = {
      merchant_id: "m-1",
      actor_id: "a-1",
      auth_strength: "session" as const,
      subject_binding: "none" as const,
    };
    expect(() => createActorContext({ ...base, merchant_id: "" })).toThrowError(
      ContextGovernanceError,
    );
    expect(() => createActorContext({ ...base, actor_id: "x".repeat(129) })).toThrowError(
      ContextGovernanceError,
    );
    expect(() => createActorContext({ ...base, actor_id: "bad\u0000id" })).toThrowError(
      ContextGovernanceError,
    );
    expect(() =>
      createActorContext({
        ...base,
        auth_strength: "anonymous" as never,
        subject_binding: "organization" as never,
      }),
    ).toThrowError(ContextGovernanceError);
    expect(() => createActorContext({ ...base, auth_strength: "root" as never })).toThrowError(
      ContextGovernanceError,
    );
    expect(() =>
      createActorContext({ ...base, subject_binding: "device" as never }),
    ).toThrowError(ContextGovernanceError);
  });
});

describe("DataUseGrant 存储（设计 §4.2 / §9.2）", () => {
  let db: DatabaseSync;
  let grants: DataUseGrantStore;
  let clock: string;

  beforeEach(() => {
    clock = NOW;
    db = new DatabaseSync(":memory:");
    migrateMerchantOpsSchema(db);
    registerGovernanceLedgers(db);
    grants = new DataUseGrantStore({ db, now: () => clock });
  });
  afterEach(() => db.close());

  it("创建 ACTIVE 授权；记忆/历史/经验/通知用途互不替代", () => {
    const memory = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: LATER,
    });
    expect(memory.status).toBe("ACTIVE");
    expect(memory.grant_epoch).toBe(1);

    expect(
      grants.getActiveGrant({
        merchant_id: "m-1",
        subject_id: "subj-1",
        purpose: "history_recall",
        resource_scope_id: "org",
      }),
    ).toBeUndefined();
    expect(
      grants.getActiveGrant({
        merchant_id: "m-1",
        subject_id: "subj-1",
        purpose: "experience_learning",
        resource_scope_id: "org",
      }),
    ).toBeUndefined();
    expect(
      grants.getActiveGrant({
        merchant_id: "m-1",
        subject_id: "subj-1",
        purpose: "notification",
        resource_scope_id: "org",
      }),
    ).toBeUndefined();
  });

  it("撤销 CAS：expected_epoch 不匹配拒绝；撤销递增 epoch，重新授权继续递增", () => {
    const grant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: LATER,
    });
    expect(() =>
      grants.revokeGrant({ merchant_id: "m-1", grant_id: grant.grant_id, expected_epoch: 2 }),
    ).toThrowError(ContextGovernanceError);
    try {
      grants.revokeGrant({ merchant_id: "m-1", grant_id: grant.grant_id, expected_epoch: 2 });
    } catch (err) {
      expect((err as ContextGovernanceError).code).toBe("version_conflict");
    }

    // §17.1 memory.revokeGrant 返回新 grant_epoch：撤销把 epoch 1 递增到 2。
    const revoked = grants.revokeGrant({
      merchant_id: "m-1",
      grant_id: grant.grant_id,
      expected_epoch: 1,
    });
    expect(revoked.status).toBe("REVOKED");
    expect(revoked.grant_epoch).toBe(2);
    expect(
      grants.getActiveGrant({
        merchant_id: "m-1",
        subject_id: "subj-1",
        purpose: "customer_memory",
        resource_scope_id: "org",
      }),
    ).toBeUndefined();

    const regrant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: LATER,
    });
    expect(regrant.grant_id).not.toBe(grant.grant_id);
    expect(regrant.grant_epoch).toBe(3);
    expect(
      grants.getActiveGrant({
        merchant_id: "m-1",
        subject_id: "subj-1",
        purpose: "customer_memory",
        resource_scope_id: "org",
      })?.grant_epoch,
    ).toBe(3);
  });

  it("过期：now 等于 expires_at 即失效；expireDue 幂等翻转状态", () => {
    const grant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: "2026-11-16T00:00:00.000Z",
    });
    clock = "2026-11-16T00:00:00.000Z"; // 到期等号
    expect(
      grants.getActiveGrant({
        merchant_id: "m-1",
        subject_id: "subj-1",
        purpose: "customer_memory",
        resource_scope_id: "org",
      }),
    ).toBeUndefined();
    expect(grants.expireDue()).toBe(1);
    expect(grants.expireDue()).toBe(0);
    expect(
      grants.listBySubject({ merchant_id: "m-1", subject_id: "subj-1" })[0]?.status,
    ).toBe("EXPIRED");
    // 到期后重新授权是新 epoch。
    const regrant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: LATER,
    });
    expect(regrant.grant_epoch).toBe(2);
    void grant;
  });

  it("审计时间统一 UTC：created_at/updated_at 规范化定宽，不落偏移形式", () => {
    clock = "2026-11-15T08:00:00+08:00"; // 偏移时钟（= UTC 2026-11-15T00:00:00Z）
    const grant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: "2026-12-15T00:00:00.000Z",
    });
    // 修复前：created_at/updated_at 直接存 now() 原文（偏移形式）。
    expect(grant.created_at).toBe("2026-11-15T00:00:00.000Z");
    expect(grant.updated_at).toBe("2026-11-15T00:00:00.000Z");
    const revoked = grants.revokeGrant({
      merchant_id: "m-1",
      grant_id: grant.grant_id,
      expected_epoch: 1,
    });
    expect(revoked.updated_at).toBe("2026-11-15T00:00:00.000Z");
    expect(revoked.updated_at.endsWith("Z")).toBe(true);
  });

  it("时间规范化：非 UTC 偏移拒绝；存储统一为定宽 UTC", () => {
    // RFC3339 偏移形式（= UTC 2026-11-16T00:00:00Z）被拒绝：SQL 到期比较按
    // 字符串进行，偏移/精度差异会破坏字典序与时刻序一致性。
    expect(() =>
      grants.createGrant({
        merchant_id: "m-1",
        subject_id: "subj-1",
        purpose: "customer_memory",
        resource_scope_id: "org",
        expires_at: "2026-11-16T08:00:00+08:00",
      }),
    ).toThrowError(ContextGovernanceError);
    try {
      grants.createGrant({
        merchant_id: "m-1",
        subject_id: "subj-1",
        purpose: "customer_memory",
        resource_scope_id: "org",
        expires_at: "2026-11-16T08:00:00+08:00",
      });
    } catch (err) {
      expect((err as ContextGovernanceError).reason).toBe("expires_at_not_utc");
    }
    // 秒级精度（"…00Z"）合法：入库规范化为定宽 "…00.000Z"。
    const grant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: "2026-12-15T00:00:00Z",
    });
    expect(grant.expires_at).toBe("2026-12-15T00:00:00.000Z");
  });

  it("到期判定与偏移时钟：到期等号即失效，不因偏移/精度差异误判", () => {
    const grant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: "2026-11-16T00:00:00.000Z",
    });
    const key = {
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory" as const,
      resource_scope_id: "org",
    };
    // 到期前 1 秒（偏移形式时钟，= UTC 2026-11-15T23:59:59Z）→ 仍有效。
    clock = "2026-11-15T15:59:59-08:00";
    expect(grants.getActiveGrant(key)).toBeDefined();
    // 到期等号（偏移形式时钟，= UTC 2026-11-16T00:00:00Z）→ 失效。
    // 修复前：存储值 "2026-11-16T00:00:00.000Z" 与偏移字符串做字典序比较，
    // '6' > '5' 误判为未到期。
    clock = "2026-11-15T16:00:00-08:00";
    expect(grants.getActiveGrant(key)).toBeUndefined();
    expect(grants.currentGrantEpoch("m-1", grant.grant_id)).toBeUndefined();
  });

  it("作用域查询：跨商家、跨主体不泄露", () => {
    grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: LATER,
    });
    expect(grants.listBySubject({ merchant_id: "m-2", subject_id: "subj-1" })).toHaveLength(0);
    expect(grants.listBySubject({ merchant_id: "m-1", subject_id: "subj-2" })).toHaveLength(0);
    expect(grants.currentGrantEpoch("m-2", "fake-grant")).toBeUndefined();

    // 商家 B 撤销商家 A 的 grant：不存在性不泄露（access_denied）。
    const grant = grants.listBySubject({ merchant_id: "m-1", subject_id: "subj-1" })[0]!;
    expect(() =>
      grants.revokeGrant({ merchant_id: "m-2", grant_id: grant.grant_id, expected_epoch: 1 }),
    ).toThrowError(ContextGovernanceError);
  });

  it("形状校验：过期时间非法/已过、未知 purpose、坏 ID 拒绝", () => {
    const base = {
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory" as const,
      resource_scope_id: "org",
    };
    expect(() => grants.createGrant({ ...base, expires_at: "tomorrow" })).toThrowError(
      ContextGovernanceError,
    );
    expect(() => grants.createGrant({ ...base, expires_at: NOW })).toThrowError(
      ContextGovernanceError,
    );
    expect(() =>
      grants.createGrant({ ...base, expires_at: LATER, purpose: "marketing" as never }),
    ).toThrowError(ContextGovernanceError);
    expect(() =>
      grants.createGrant({ ...base, expires_at: LATER, subject_id: "bad\nid" }),
    ).toThrowError(ContextGovernanceError);
  });
});
