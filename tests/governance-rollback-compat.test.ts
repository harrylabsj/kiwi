/**
 * X10/X11：回退二进制/重启后的兼容性——账本、UNKNOWN 与封存/撤权状态不重置；
 * 旧构建看到更高版本账本时拒绝打开（禁止读取新数据）。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { FollowUpRepository } from "../src/merchant-core/followup/repository.js";
import { FollowUpService } from "../src/merchant-core/followup/service.js";
import { DataUseGrantStore } from "../src/merchant-core/context-governance/data-use-grant.js";
import { SourceGovernanceService } from "../src/merchant-core/context-governance/source-governance.js";

const NOW = "2026-11-18T00:00:00.000Z";
const MERCHANT = "m-1";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newDb(): { db: DatabaseSync; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-rollback-"));
  dirs.push(dir);
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  migrateMerchantOpsSchema(db);
  registerGovernanceLedgers(db);
  return { db, path };
}

describe("回退兼容（X10/X11）", () => {
  it("X10：重启/回退后 UNKNOWN 状态与账本不重置", () => {
    const first = newDb();
    const service = new FollowUpService({
      repository: new FollowUpRepository({ db: first.db, now: () => NOW }),
      now: () => NOW,
    });
    const task = service.schedule({
      merchant_id: MERCHANT,
      trigger_event: "quote_not_answered",
      action_type: "merchant_todo",
      due_at: NOW,
      max_attempts: 3,
      payload: { draft: "x" },
    }).task;
    service.markDue({ merchant_id: MERCHANT, task_id: task.task_id });
    const claimed = service.claim({
      merchant_id: MERCHANT,
      task_id: task.task_id,
      worker_id: "w1",
      lease_ms: 60_000,
    });
    service.finish({
      merchant_id: MERCHANT,
      task_id: task.task_id,
      fencing_token: claimed.task.fencing_token,
      outcome: "unknown",
      receipt: { provider_request_id: "req-1" },
    });
    first.db.close();

    const reopened = new DatabaseSync(first.path);
    try {
      const repo = new FollowUpRepository({ db: reopened, now: () => NOW });
      const after = repo.getTask(MERCHANT, task.task_id);
      expect(after?.status).toBe("UNKNOWN");
      expect(after?.attempts).toBe(1);
      // 账本版本保持，不因重启清零。
      const versions = reopened
        .prepare("SELECT version FROM merchant_ops_schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    } finally {
      reopened.close();
    }
  });

  it("X10：删除封存与撤权在重启后仍有效", () => {
    const first = newDb();
    const grants = new DataUseGrantStore({ db: first.db, now: () => NOW });
    const grant = grants.createGrant({
      merchant_id: MERCHANT,
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "scope-1",
      expires_at: "2026-12-01T00:00:00.000Z",
    });
    grants.revokeGrant({
      merchant_id: MERCHANT,
      grant_id: grant.grant_id,
      expected_epoch: grant.grant_epoch,
    });
    const source = new SourceGovernanceService({ db: first.db, now: () => NOW });
    source.registerSourceRef({
      merchant_id: MERCHANT,
      object_id: "src-1",
      version: 1,
      payload_ref: "payload-1",
      erase_scope_id: "scope-1",
      observed_at: NOW,
    });
    source.requestDeletion({
      merchant_id: MERCHANT,
      erase_scope_id: "scope-1",
      requested_by: "admin-1",
      reason: "客户删除",
    });
    first.db.close();

    const reopened = new DatabaseSync(first.path);
    try {
      const reopenedGrants = new DataUseGrantStore({ db: reopened, now: () => NOW });
      expect(
        reopenedGrants.getActiveGrant({
          merchant_id: MERCHANT,
          subject_id: "subj-1",
          purpose: "customer_memory",
          resource_scope_id: "scope-1",
        }),
      ).toBeUndefined();
      const reopenedSource = new SourceGovernanceService({ db: reopened, now: () => NOW });
      expect(reopenedSource.getDataScope(MERCHANT, "scope-1")?.state).toBe("SEALED");
    } finally {
      reopened.close();
    }
  });

  it("X11：旧构建看到更高版本账本时拒绝打开", () => {
    const { db, path } = newDb();
    db.close();
    const reopened = new DatabaseSync(path);
    try {
      expect(() => migrateMerchantOpsSchema(reopened, 3)).toThrow(/newer than this build/);
    } finally {
      reopened.close();
    }
  });
});
