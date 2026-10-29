/**
 * 跟进任务持久化与租约（v0.2 §8 / FR31–FR35、AC08/AC09）。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { FollowUpRepository } from "../src/merchant-core/followup/repository.js";
import { FollowUpService } from "../src/merchant-core/followup/service.js";
import { FollowUpError } from "../src/merchant-core/followup/types.js";

let clock = "2026-10-29T10:00:00.000Z";
const now = () => clock;
let db: DatabaseSync;
let service: FollowUpService;
let repository: FollowUpRepository;

beforeEach(() => {
  clock = "2026-10-29T10:00:00.000Z";
  db = new DatabaseSync(":memory:");
  migrateMerchantOpsSchema(db);
  repository = new FollowUpRepository({ db, now });
  service = new FollowUpService({ repository, now });
});
afterEach(() => db.close());

function schedule(overrides: Record<string, unknown> = {}) {
  return service.schedule({
    merchant_id: "merchant-1",
    opportunity_id: "opp-1",
    trigger_event: "quote_not_answered",
    action_type: "merchant_todo",
    due_at: "2026-10-29T10:00:00.000Z",
    max_attempts: 3,
    payload: { draft: "跟进草稿" },
    ...overrides,
  }).task;
}

function readyTask() {
  const task = schedule();
  return service.markDue({ merchant_id: "merchant-1", task_id: task.task_id });
}

describe("跟进任务持久化", () => {
  it("排程落 PENDING；同幂等键重放返回同一任务，异内容冲突", () => {
    const first = schedule({ idempotency_key: "fu-key-1" });
    const replay = schedule({ idempotency_key: "fu-key-1" });
    expect(replay.task_id).toBe(first.task_id);
    expect(service.list("merchant-1")).toHaveLength(1);
    expect(() =>
      schedule({ idempotency_key: "fu-key-1", trigger_event: "other" }),
    ).toThrowError(FollowUpError);
  });

  it("到期 → READY；领取原子占用并递增 fencing/attempts；重复领取失败", () => {
    const task = readyTask();
    expect(task.status).toBe("READY");

    const claimed = service.claim({
      merchant_id: "merchant-1",
      task_id: task.task_id,
      worker_id: "worker-1",
      lease_ms: 60_000,
    });
    expect(claimed.task.status).toBe("RUNNING");
    expect(claimed.task.fencing_token).toBe(1);
    expect(claimed.task.attempts).toBe(1);

    expect(() =>
      service.claim({
        merchant_id: "merchant-1",
        task_id: task.task_id,
        worker_id: "worker-2",
        lease_ms: 60_000,
      }),
    ).toThrowError(FollowUpError);
  });

  it("成功/失败/未知结果都受 fencing token 保护", () => {
    const task = readyTask();
    const claimed = service.claim({
      merchant_id: "merchant-1",
      task_id: task.task_id,
      worker_id: "worker-1",
      lease_ms: 60_000,
    }).task;

    expect(() =>
      service.finish({
        merchant_id: "merchant-1",
        task_id: claimed.task_id,
        fencing_token: 999,
        outcome: "succeeded",
      }),
    ).toThrowError(FollowUpError);

    const finished = service.finish({
      merchant_id: "merchant-1",
      task_id: claimed.task_id,
      fencing_token: claimed.fencing_token,
      outcome: "succeeded",
      receipt: { provider_id: "p-1" },
    });
    expect(finished.status).toBe("SUCCEEDED");
    expect(() =>
      service.retry({
        merchant_id: "merchant-1",
        task_id: finished.task_id,
        retryable: true,
        still_authorized: true,
      }),
    ).toThrowError(FollowUpError);
  });

  it("租约过期：未外发回 READY；已外发保持 UNKNOWN", () => {
    const notSent = readyTask();
    const first = service.claim({
      merchant_id: "merchant-1",
      task_id: notSent.task_id,
      worker_id: "worker-1",
      lease_ms: 1_000,
    }).task;
    clock = "2026-10-29T10:00:05.000Z";
    const recovered = service.recoverExpiredLeases("merchant-1");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("READY");
    expect(recovered[0]?.fencing_token).toBe(first.fencing_token);

    const sent = readyTask();
    const claimed = service.claim({
      merchant_id: "merchant-1",
      task_id: sent.task_id,
      worker_id: "worker-1",
      lease_ms: 1_000,
    }).task;
    service.markExternalStarted({
      merchant_id: "merchant-1",
      task_id: claimed.task_id,
      fencing_token: claimed.fencing_token,
    });
    clock = "2026-10-29T10:00:10.000Z";
    const unknown = service.recoverExpiredLeases("merchant-1");
    expect(unknown.map((task) => task.status)).toContain("UNKNOWN");
  });

  it("等待批准：批准有效回 READY/PENDING，退回终止", () => {
    const task = readyTask();
    const claimed = service.claim({
      merchant_id: "merchant-1",
      task_id: task.task_id,
      worker_id: "worker-1",
      lease_ms: 60_000,
    }).task;
    const waiting = service.needApproval({
      merchant_id: "merchant-1",
      task_id: claimed.task_id,
      fencing_token: claimed.fencing_token,
    });
    expect(waiting.status).toBe("WAITING_APPROVAL");
    expect(service.approve({ merchant_id: "merchant-1", task_id: waiting.task_id, still_due: true }).status).toBe(
      "READY",
    );

    const second = readyTask();
    const claimedSecond = service.claim({
      merchant_id: "merchant-1",
      task_id: second.task_id,
      worker_id: "worker-2",
      lease_ms: 60_000,
    }).task;
    const waitingSecond = service.needApproval({
      merchant_id: "merchant-1",
      task_id: claimedSecond.task_id,
      fencing_token: claimedSecond.fencing_token,
    });
    expect(service.reject({ merchant_id: "merchant-1", task_id: waitingSecond.task_id }).status).toBe(
      "CANCELLED",
    );
  });

  it("重试预算：用尽后停在 FAILED；UNKNOWN 只能靠证据解决", () => {
    let task = readyTask();
    for (let i = 0; i < 3; i += 1) {
      const claimed = service.claim({
        merchant_id: "merchant-1",
        task_id: task.task_id,
        worker_id: `worker-${i}`,
        lease_ms: 60_000,
      }).task;
      task = service.finish({
        merchant_id: "merchant-1",
        task_id: claimed.task_id,
        fencing_token: claimed.fencing_token,
        outcome: "failed",
        error_code: "channel_rejected",
      });
      task =
        i < 2
          ? service.retry({
              merchant_id: "merchant-1",
              task_id: task.task_id,
              retryable: true,
              still_authorized: true,
            })
          : service.retry({
              merchant_id: "merchant-1",
              task_id: task.task_id,
              retryable: true,
              still_authorized: true,
            });
      if (i < 2) task = service.markDue({ merchant_id: "merchant-1", task_id: task.task_id });
    }
    expect(task.status).toBe("FAILED");

    const unknownTask = readyTask();
    const claimed = service.claim({
      merchant_id: "merchant-1",
      task_id: unknownTask.task_id,
      worker_id: "worker-x",
      lease_ms: 60_000,
    }).task;
    const unknown = service.finish({
      merchant_id: "merchant-1",
      task_id: claimed.task_id,
      fencing_token: claimed.fencing_token,
      outcome: "unknown",
    });
    expect(unknown.status).toBe("UNKNOWN");
    expect(
      service.resolve({
        merchant_id: "merchant-1",
        task_id: unknown.task_id,
        outcome: "completed",
        still_authorized: true,
      }).status,
    ).toBe("SUCCEEDED");
  });

  it("停止：未外发取消；在途保持 UNKNOWN 且记录 stop_requested", () => {
    const pending = schedule();
    expect(service.stop({ merchant_id: "merchant-1", task_id: pending.task_id, in_flight: false }).status).toBe(
      "CANCELLED",
    );

    const task = readyTask();
    const claimed = service.claim({
      merchant_id: "merchant-1",
      task_id: task.task_id,
      worker_id: "worker-1",
      lease_ms: 60_000,
    }).task;
    const stopped = service.stop({ merchant_id: "merchant-1", task_id: claimed.task_id, in_flight: true });
    expect(stopped.status).toBe("UNKNOWN");
    expect(stopped.stop_requested).toBe(true);
  });

  it("租户隔离与 outbox 记录", () => {
    const task = schedule();
    expect(service.get("merchant-2", task.task_id)).toBeUndefined();
    expect(() =>
      service.markDue({ merchant_id: "merchant-2", task_id: task.task_id }),
    ).toThrowError(FollowUpError);

    repository.enqueueOutbox({
      merchantId: "merchant-1",
      taskId: task.task_id,
      payload: { kind: "merchant_todo" },
    });
  });
});
