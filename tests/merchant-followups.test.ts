/**
 * 跟进任务状态机、重试预算与租约判定（v0.2 §8 / FR31–FR35、AC08/AC09）。
 */
import { describe, expect, it } from "vitest";

import { transitionFollowUp } from "../src/merchant-core/followup/state.js";
import { expiredLeaseOutcome, canCommitFencedWrite } from "../src/merchant-core/followup/lease.js";
import { canRetry, nextRetryDelayMs } from "../src/merchant-core/followup/retry.js";
import { FollowUpError, type FollowUpEvent, type FollowUpStatus } from "../src/merchant-core/followup/types.js";

function move(from: FollowUpStatus, event: FollowUpEvent) {
  return transitionFollowUp(from, event);
}

describe("跟进任务状态机（§8.5）", () => {
  it("新建 → 待执行；到期后才可领取", () => {
    expect(move("NEW", { type: "SCHEDULE" })).toMatchObject({ to: "PENDING" });
    expect(move("PENDING", { type: "DUE", due: false }).to).toBe("PENDING");
    expect(move("PENDING", { type: "DUE", due: true }).to).toBe("READY");
    expect(move("PENDING", { type: "DUE", due: true, requires_approval: true }).to).toBe(
      "WAITING_APPROVAL",
    );
    expect(move("READY", { type: "CLAIM" }).to).toBe("RUNNING");
    expect(move("READY", { type: "CLAIM", requires_approval: true }).to).toBe("WAITING_APPROVAL");
  });

  it("批准退回：批准有效回到待执行，退回终止", () => {
    expect(move("WAITING_APPROVAL", { type: "APPROVE", still_due: true }).to).toBe("READY");
    expect(move("WAITING_APPROVAL", { type: "APPROVE", still_due: false }).to).toBe("PENDING");
    expect(move("WAITING_APPROVAL", { type: "REJECT" }).to).toBe("CANCELLED");
  });

  it("执行结果：成功/确定失败/可能发生但无回执", () => {
    expect(move("RUNNING", { type: "SUCCEED" }).to).toBe("SUCCEEDED");
    expect(move("RUNNING", { type: "FAIL", reason_code: "channel_rejected" }).to).toBe("FAILED");
    expect(move("RUNNING", { type: "UNKNOWN" }).to).toBe("UNKNOWN");
  });

  it("FAILED 重试受预算与授权约束；达到上限停在 FAILED", () => {
    const retry = (overrides: Partial<Extract<FollowUpEvent, { type: "RETRY" }>> = {}) =>
      move("FAILED", {
        type: "RETRY",
        retryable: true,
        attempts_so_far: 1,
        max_attempts: 3,
        still_authorized: true,
        ...overrides,
      });

    expect(retry().to).toBe("PENDING");
    expect(retry({ attempts_so_far: 3 }).to).toBe("FAILED");
    expect(retry({ still_authorized: false }).to).toBe("FAILED");
    expect(retry({ retryable: false }).to).toBe("FAILED");
  });

  it("租约过期：证明未外发才回 READY，否则 UNKNOWN", () => {
    expect(move("RUNNING", { type: "LEASE_EXPIRED", proven_not_sent: true }).to).toBe("READY");
    expect(move("RUNNING", { type: "LEASE_EXPIRED", proven_not_sent: false }).to).toBe("UNKNOWN");
  });

  it("UNKNOWN 只能由回执/权威查询/有证据的人工核对解决", () => {
    expect(move("UNKNOWN", { type: "RESOLVE", outcome: "completed", still_authorized: true }).to).toBe(
      "SUCCEEDED",
    );
    expect(move("UNKNOWN", { type: "RESOLVE", outcome: "failed", still_authorized: true }).to).toBe(
      "FAILED",
    );
    expect(
      move("UNKNOWN", { type: "RESOLVE", outcome: "not_executed", still_authorized: true }).to,
    ).toBe("READY");
    expect(
      move("UNKNOWN", { type: "RESOLVE", outcome: "not_executed", still_authorized: false }).to,
    ).toBe("CANCELLED");
  });

  it("停止：未外发取消；在途/结果不明保持 UNKNOWN 并记录 stop_requested", () => {
    expect(move("PENDING", { type: "STOP", in_flight: false }).to).toBe("CANCELLED");
    expect(move("READY", { type: "STOP", in_flight: false }).to).toBe("CANCELLED");
    expect(move("WAITING_APPROVAL", { type: "STOP", in_flight: false }).to).toBe("CANCELLED");
    expect(move("RUNNING", { type: "STOP", in_flight: false }).to).toBe("CANCELLED");
    const inFlight = move("RUNNING", { type: "STOP", in_flight: true });
    expect(inFlight.to).toBe("UNKNOWN");
    expect(inFlight.side_effects).toContain("record_stop_requested");
    expect(move("UNKNOWN", { type: "STOP", in_flight: false }).to).toBe("UNKNOWN");
  });

  it("终态不可恢复、不可重试；非法迁移直接拒绝", () => {
    for (const status of ["SUCCEEDED", "CANCELLED"] as const) {
      expect(() => move(status, { type: "SUCCEED" })).toThrowError(
        expect.objectContaining({ code: "terminal_state" }),
      );
      expect(() => move(status, { type: "RETRY", retryable: true, attempts_so_far: 0, max_attempts: 3, still_authorized: true })).toThrowError(
        expect.objectContaining({ code: "terminal_state" }),
      );
    }
    expect(() => move("PENDING", { type: "SUCCEED" })).toThrowError(
      expect.objectContaining({ code: "invalid_transition" }),
    );
    expect(() => move("READY", { type: "RESOLVE", outcome: "completed", still_authorized: true })).toThrowError(
      FollowUpError,
    );
  });
});

describe("重试预算（FR35）", () => {
  const policy = { max_attempts: 4, base_delay_ms: 1_000, max_delay_ms: 8_000 };

  it("指数退避并受 max_delay 限制", () => {
    expect(nextRetryDelayMs(policy, 1)).toBe(1_000);
    expect(nextRetryDelayMs(policy, 2)).toBe(2_000);
    expect(nextRetryDelayMs(policy, 4)).toBe(8_000);
    expect(nextRetryDelayMs(policy, 5)).toBe(8_000);
  });

  it("来源 Retry-After 优先于本地退避", () => {
    expect(nextRetryDelayMs(policy, 3, 30_000)).toBe(30_000);
  });

  it("预算判断与非法输入", () => {
    expect(canRetry(policy, 0)).toBe(true);
    expect(canRetry(policy, 3)).toBe(true);
    expect(canRetry(policy, 4)).toBe(false);
    expect(() => nextRetryDelayMs(policy, 0)).toThrowError(FollowUpError);
    expect(() => nextRetryDelayMs({ ...policy, base_delay_ms: -1 }, 1)).toThrowError(FollowUpError);
  });
});

describe("租约与 fencing（FR32）", () => {
  const now = "2026-10-29T10:00:00.000Z";

  it("只有当前 fencing token 且未过期才能提交", () => {
    expect(
      canCommitFencedWrite({
        lease_fencing_token: 3,
        current_fencing_token: 3,
        lease_expires_at: "2026-10-29T10:01:00.000Z",
        now,
      }),
    ).toBe(true);
    expect(
      canCommitFencedWrite({
        lease_fencing_token: 2,
        current_fencing_token: 3,
        lease_expires_at: "2026-10-29T10:01:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      canCommitFencedWrite({
        lease_fencing_token: 3,
        current_fencing_token: 3,
        lease_expires_at: now,
        now,
      }),
    ).toBe(false);
  });

  it("租约过期只证明内部写入失效，不推断外部动作", () => {
    expect(expiredLeaseOutcome(true)).toBe("READY");
    expect(expiredLeaseOutcome(false)).toBe("UNKNOWN");
  });
});
