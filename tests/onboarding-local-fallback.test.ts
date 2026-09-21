/**
 * M4 本地兜底两种状态（设计 §5.4 / T012）。
 *
 * 关键不是"页面上写了什么"，而是**安全闸门由状态推导**：
 *   - 首次未发布 **不接待**（不允许"先挂出去再说"）；
 *   - 已营业故障 **停止受影响的新询价**，但**暂停/撤回安全动作仍可用**；
 *   - 控制面不可达时，本地**不得**宣布"已恢复"。
 */
import { describe, expect, it } from "vitest";

import {
  degradedRecoveryAsk,
  deriveLocalFallback,
  type LocalFallbackInput,
} from "../src/cloud/onboarding/local-fallback.js";

function input(overrides: Partial<LocalFallbackInput> = {}): LocalFallbackInput {
  return {
    publicationState: "NONE",
    readiness: { ready: true, checks: {} },
    controlPlaneReachable: true,
    ...overrides,
  };
}

describe("§5.4：首次未发布", () => {
  it("没有活动版本 → 不接待新询价（组件全就绪也不改变这一点）", () => {
    const view = deriveLocalFallback(input({ publicationState: "NONE" }));
    expect(view.state).toBe("FIRST_TIME_UNPUBLISHED");
    expect(view.acceptsNewInquiries).toBe(false);
    expect(view.summary).toContain("不接待");
  });

  it("首次开通失败停在可重试失败态时，本地视图仍是「未发布」而不是「营业中」", () => {
    // 记录里的状态推进不到 PUBLISHED；本地只能看到"没有活动版本"
    const view = deriveLocalFallback(
      input({ publicationState: "NONE", readiness: { ready: false, checks: { products: { ok: false, code: "no_products" } } } }),
    );
    expect(view.state).toBe("FIRST_TIME_UNPUBLISHED");
    expect(view.acceptsNewInquiries).toBe(false);
  });
});

describe("§5.4/T012：已营业故障", () => {
  it("有活动版本但组件不就绪 → 停止新询价，安全动作仍可用", () => {
    const view = deriveLocalFallback(
      input({
        publicationState: "ACTIVE",
        readiness: { ready: false, checks: { storage: { ok: false, code: "storage_unwritable" } } },
      }),
    );
    expect(view.state).toBe("OPERATING_DEGRADED");
    expect(view.acceptsNewInquiries).toBe(false);
    // 安全动作不能被故障锁死
    expect(view.safeActions).toContain("pause");
    expect(view.safeActions).toContain("withdraw");
    expect(view.summary).toContain("storage");
  });

  it("ready=false 但 checks 为空也算故障（不因为「没细节」就当正常）", () => {
    const view = deriveLocalFallback(
      input({ publicationState: "ACTIVE", readiness: { ready: false, checks: {} } }),
    );
    expect(view.state).toBe("OPERATING_DEGRADED");
    expect(view.acceptsNewInquiries).toBe(false);
  });

  it("任一 check 失败即故障（不是全挂才算）", () => {
    const view = deriveLocalFallback(
      input({
        publicationState: "ACTIVE",
        readiness: { ready: true, checks: { policy: { ok: false, code: "policy_stale" } } },
      }),
    );
    expect(view.state).toBe("OPERATING_DEGRADED");
  });

  it("组件就绪 + 活动版本 → 正常营业", () => {
    const view = deriveLocalFallback(input({ publicationState: "ACTIVE" }));
    expect(view.state).toBe("OPERATING");
    expect(view.acceptsNewInquiries).toBe(true);
  });
});

describe("治理状态：暂停与撤回", () => {
  it("暂停：公开信息仍在但不接待；可恢复或撤回", () => {
    const view = deriveLocalFallback(input({ publicationState: "PAUSED" }));
    expect(view.state).toBe("PAUSED_BY_MERCHANT");
    expect(view.acceptsNewInquiries).toBe(false);
    expect(view.safeActions).toEqual(["resume", "withdraw"]);
  });

  it("撤回：不接待；重新发布需新建版本（不复活旧版本）", () => {
    const view = deriveLocalFallback(input({ publicationState: "WITHDRAWN" }));
    expect(view.state).toBe("WITHDRAWN");
    expect(view.acceptsNewInquiries).toBe(false);
    expect(view.safeActions).toEqual(["republish"]);
  });
});

describe("权威边界：本地视图不得自行宣布恢复", () => {
  it("控制面不可达 → 必须对账，并给出待确认问题；权威声明原样带出", () => {
    const strict = input({ publicationState: "ACTIVE", controlPlaneReachable: false });
    const view = deriveLocalFallback(strict);
    expect(view.requiresControlPlaneReconciliation).toBe(true);
    expect(view.authorityNote).toContain("不是权威状态");
    const asks = degradedRecoveryAsk(strict);
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.join(" ")).toContain("不会自动");
  });

  it("控制面可达时不产生额外对账要求", () => {
    expect(degradedRecoveryAsk(input({ controlPlaneReachable: true }))).toEqual([]);
  });

  it("本地视图永不把故障描述成「已恢复/已开通」", () => {
    for (const state of ["NONE", "ACTIVE", "PAUSED", "WITHDRAWN"] as const) {
      const view = deriveLocalFallback(
        input({
          publicationState: state,
          readiness: { ready: false, checks: { identity: { ok: false, code: "identity_corrupt" } } },
          controlPlaneReachable: false,
        }),
      );
      expect(view.summary).not.toMatch(/已恢复|已开通成功|一切正常/);
    }
  });
});
