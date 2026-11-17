/**
 * TOP1-3 M1：来源治理与可恢复删除（设计 §4.2 / §12.2 / §18.1 / §22.1 M1）。
 * 来源版本不可变、封存 scope 递增 data_epoch、撤权 + erased + 派生边封存、
 * 删除任务逐存储面 purged/pending/failed 可幂等重试；ContextGuard 在删除后
 * 立即拒绝旧快照与旧来源。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { DataUseGrantStore } from "../src/merchant-core/context-governance/data-use-grant.js";
import { createGrantBackedAuthority } from "../src/merchant-core/context-governance/authority.js";
import {
  ContextGuard,
  type ContextSnapshot,
} from "../src/merchant-core/context-governance/context-guard.js";
import { createActorContext } from "../src/merchant-core/context-governance/actor-context.js";
import {
  DELETION_SURFACES,
  SourceGovernanceService,
} from "../src/merchant-core/context-governance/source-governance.js";
import { ContextGovernanceError } from "../src/merchant-core/context-governance/types.js";

const NOW = "2026-11-15T00:00:00.000Z";
const LATER = "2026-12-15T00:00:00.000Z";

function expectGovernanceError(fn: () => unknown, code: string, reason: string): void {
  try {
    fn();
    expect.unreachable(`应抛出 ${code}/${reason}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ContextGovernanceError);
    const e = err as ContextGovernanceError;
    expect(e.code).toBe(code);
    expect(e.reason).toContain(reason);
  }
}

describe("SourceGovernance（来源治理与删除）", () => {
  let db: DatabaseSync;
  let clock: string;
  let service: SourceGovernanceService;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    registerGovernanceLedgers(db);
    clock = NOW;
    service = new SourceGovernanceService({ db, now: () => clock });
  });
  afterEach(() => db.close());

  function registerDefaults(overrides: Partial<Parameters<SourceGovernanceService["registerSourceRef"]>[0]> = {}) {
    return service.registerSourceRef({
      merchant_id: "m-1",
      object_id: "src-1",
      version: 1,
      payload_ref: "payload-1",
      erase_scope_id: "scope-1",
      observed_at: NOW,
      expires_at: LATER,
      ...overrides,
    });
  }

  it("来源版本登记：幂等、版本不可变、过期/版本失配不可用", () => {
    const first = registerDefaults();
    expect(first.version).toBe(1);
    expect(first.erased_at).toBeNull();
    // 首次登记自动建立 ACTIVE data_scope（epoch 1）。
    expect(service.currentDataScopeEpoch("m-1", "scope-1")).toBe(1);

    // 同版本同内容：幂等返回原记录。
    const again = registerDefaults();
    expect(again).toEqual(first);

    // 同版本不同 payload：版本不可变。
    expectGovernanceError(
      () => registerDefaults({ payload_ref: "payload-2" }),
      "version_conflict",
      "source_ref_immutable",
    );

    // 可用性：当前可用；版本不存在不可用。
    expect(service.isAvailable("m-1", { object_id: "src-1", version: 1 })).toBe(true);
    expect(service.isAvailable("m-1", { object_id: "src-1", version: 2 })).toBe(false);
    // 跨商家不可用（作用域隔离）。
    expect(service.isAvailable("m-2", { object_id: "src-1", version: 1 })).toBe(false);

    // 过期即不可用（now 等于 expires_at 也失效）。
    clock = LATER;
    expect(service.isAvailable("m-1", { object_id: "src-1", version: 1 })).toBe(false);
  });

  it("派生边：幂等登记；同边异 child_kind 内容冲突；父来源删除后拒绝迟到派生", () => {
    registerDefaults();
    const edge = {
      merchant_id: "m-1",
      parent_object_id: "src-1",
      parent_version: 1,
      child_object_id: "mem-1",
      child_kind: "customer_memory",
    };
    service.recordDerivationEdge(edge);
    service.recordDerivationEdge(edge); // 幂等
    expect(db.prepare("SELECT COUNT(*) AS n FROM derivation_edges").get()).toEqual({ n: 1 });
    expectGovernanceError(
      () => service.recordDerivationEdge({ ...edge, child_kind: "draft" }),
      "version_conflict",
      "derivation_edge_immutable",
    );
    service.requestDeletion({
      merchant_id: "m-1",
      erase_scope_id: "scope-1",
      requested_by: "admin-1",
      reason: "删除",
    });
    expectGovernanceError(
      () =>
        service.recordDerivationEdge({
          ...edge,
          child_object_id: "mem-2",
        }),
      "source_unavailable",
      "parent_source_unavailable",
    );
  });

  it("删除请求：先封存 scope（epoch+1）→ 撤销 grant → erased 来源 → 封存派生边 → 建 PENDING 存储面", () => {
    const grants = new DataUseGrantStore({ db, now: () => clock });
    const grant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "scope-1",
      expires_at: LATER,
    });
    // 另一 scope 的 grant 不受影响。
    const otherGrant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "scope-2",
      expires_at: LATER,
    });
    registerDefaults();
    registerDefaults({ object_id: "src-2", payload_ref: "payload-2" });
    service.recordDerivationEdge({
      merchant_id: "m-1",
      parent_object_id: "src-1",
      parent_version: 1,
      child_object_id: "mem-1",
      child_kind: "customer_memory",
    });

    const job = service.requestDeletion({
      merchant_id: "m-1",
      erase_scope_id: "scope-1",
      requested_by: "admin-1",
      reason: "客户删除请求",
    });
    expect(job.state).toBe("PENDING");
    expect(job.data_epoch).toBe(2);
    expect(job.surfaces.map((surface) => surface.surface).sort()).toEqual(
      [...DELETION_SURFACES].sort(),
    );
    expect(job.surfaces.every((surface) => surface.status === "PENDING")).toBe(true);

    // scope 已封存且 epoch 递增；快照权威值不再返回。
    expect(service.getDataScope("m-1", "scope-1")).toMatchObject({
      state: "SEALED",
      data_epoch: 2,
    });
    expect(service.currentDataScopeEpoch("m-1", "scope-1")).toBeUndefined();

    // 该 scope 的 ACTIVE grant 全部撤销（epoch 递增），其他 scope 不变。
    const revoked = db
      .prepare("SELECT grant_epoch, status FROM data_grants WHERE grant_id = ?")
      .get(grant.grant_id) as { grant_epoch: number; status: string };
    expect(revoked).toEqual({ grant_epoch: 2, status: "REVOKED" });
    const untouched = db
      .prepare("SELECT status FROM data_grants WHERE grant_id = ?")
      .get(otherGrant.grant_id) as { status: string };
    expect(untouched.status).toBe("ACTIVE");

    // 来源立即不可读；派生边已封存（M3 依边传播清理）。
    expect(service.getSourceRef("m-1", "src-1", 1)?.erased_at).not.toBeNull();
    expect(service.isAvailable("m-1", { object_id: "src-1", version: 1 })).toBe(false);
    expect(
      db.prepare("SELECT sealed_at FROM derivation_edges").get(),
    ).toMatchObject({ sealed_at: NOW });

    // 已封存 scope 不再接受新来源/迟到派生边。
    expectGovernanceError(
      () => registerDefaults({ object_id: "src-3" }),
      "source_unavailable",
      "erase_scope_sealed",
    );
    expectGovernanceError(
      () => service.registerSourceRef({
        merchant_id: "m-1",
        object_id: "src-1",
        version: 1,
        payload_ref: "payload-late",
        erase_scope_id: "scope-2",
        observed_at: NOW,
      }),
      "source_unavailable",
      "source_ref_erased",
    );
  });

  it("同 key 多个 ACTIVE 授权：批量撤销逐条递增 epoch（无唯一约束冲突）", () => {
    const grants = new DataUseGrantStore({ db, now: () => clock });
    const input = {
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory" as const,
      resource_scope_id: "scope-multi",
      expires_at: LATER,
    };
    const first = grants.createGrant(input);
    const second = grants.createGrant(input);
    expect(first.grant_epoch).toBe(1);
    expect(second.grant_epoch).toBe(2);
    service.requestDeletion({
      merchant_id: "m-1",
      erase_scope_id: "scope-multi",
      requested_by: "admin-1",
      reason: "删除",
    });
    const rows = db
      .prepare(
        "SELECT grant_epoch, status FROM data_grants WHERE resource_scope_id = ? ORDER BY grant_epoch",
      )
      .all("scope-multi") as Array<{ grant_epoch: number; status: string }>;
    expect(rows).toEqual([
      { grant_epoch: 3, status: "REVOKED" },
      { grant_epoch: 4, status: "REVOKED" },
    ]);
  });

  it("删除请求幂等：同 scope 有开放任务时返回原任务，不重复递增 epoch", () => {
    registerDefaults();
    const first = service.requestDeletion({
      merchant_id: "m-1",
      erase_scope_id: "scope-1",
      requested_by: "admin-1",
      reason: "删除",
    });
    const again = service.requestDeletion({
      merchant_id: "m-1",
      erase_scope_id: "scope-1",
      requested_by: "admin-1",
      reason: "重复请求",
    });
    expect(again.deletion_job_id).toBe(first.deletion_job_id);
    expect(again.data_epoch).toBe(first.data_epoch);
    expect(service.getDataScope("m-1", "scope-1")?.data_epoch).toBe(2);
    expect(service.listOpenDeletionJobs("m-1")).toHaveLength(1);
  });

  it("存储面生命周期：逐个 PURGED → COMPLETED（幂等）；FAILED 可 retry 后完成", () => {
    const job = service.requestDeletion({
      merchant_id: "m-1",
      erase_scope_id: "scope-1",
      requested_by: "admin-1",
      reason: "删除",
    });
    for (const surface of DELETION_SURFACES) {
      const updated = service.completeSurface({
        merchant_id: "m-1",
        deletion_job_id: job.deletion_job_id,
        surface,
        receipt_ref: `rcpt-${surface}`,
      });
      expect(updated.surfaces.find((item) => item.surface === surface)).toMatchObject({
        status: "PURGED",
        receipt_ref: `rcpt-${surface}`,
      });
    }
    const completed = service.getDeletionJob("m-1", job.deletion_job_id)!;
    expect(completed.state).toBe("COMPLETED");
    // 幂等：已完成任务的再次 complete 不改变状态。
    expect(
      service.completeSurface({
        merchant_id: "m-1",
        deletion_job_id: job.deletion_job_id,
        surface: "caches",
      }).state,
    ).toBe("COMPLETED");

    // 失败与重试：FAILED 记录原因且 attempts 递增；retry 回到 PENDING。
    const job2 = service.requestDeletion({
      merchant_id: "m-2",
      erase_scope_id: "scope-9",
      requested_by: "admin-1",
      reason: "删除",
    });
    const failed = service.failSurface({
      merchant_id: "m-2",
      deletion_job_id: job2.deletion_job_id,
      surface: "backups",
      reason: "backup_pending",
    });
    expect(failed.state).toBe("PROCESSING");
    expect(failed.surfaces.find((item) => item.surface === "backups")).toMatchObject({
      status: "FAILED",
      attempts: 1,
      last_error: "backup_pending",
    });
    const retried = service.retrySurface({
      merchant_id: "m-2",
      deletion_job_id: job2.deletion_job_id,
      surface: "backups",
    });
    expect(retried.surfaces.find((item) => item.surface === "backups")).toMatchObject({
      status: "PENDING",
      attempts: 1,
    });
  });

  it("跨商家隔离：任务/来源/可用性不跨商家泄漏", () => {
    registerDefaults();
    const job = service.requestDeletion({
      merchant_id: "m-1",
      erase_scope_id: "scope-1",
      requested_by: "admin-1",
      reason: "删除",
    });
    expect(service.getDeletionJob("m-2", job.deletion_job_id)).toBeUndefined();
    expect(service.listOpenDeletionJobs("m-2")).toEqual([]);
    expectGovernanceError(
      () =>
        service.completeSurface({
          merchant_id: "m-2",
          deletion_job_id: job.deletion_job_id,
          surface: "caches",
        }),
      "access_denied",
      "deletion_job_not_found",
    );
    // 另一商家可独立登记同 object_id（主键含 merchant）。
    const other = service.registerSourceRef({
      merchant_id: "m-2",
      object_id: "src-1",
      version: 1,
      payload_ref: "payload-1",
      erase_scope_id: "scope-1",
      observed_at: NOW,
    });
    expect(other.erased_at).toBeNull();
  });
});

describe("ContextGuard 接入来源治理（撤权/删除竞态）", () => {
  let db: DatabaseSync;
  let clock: string;
  let service: SourceGovernanceService;
  let grants: DataUseGrantStore;
  let guard: ContextGuard;
  let actor: ReturnType<typeof createActorContext>;
  let grantId: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    registerGovernanceLedgers(db);
    clock = NOW;
    service = new SourceGovernanceService({ db, now: () => clock });
    grants = new DataUseGrantStore({ db, now: () => clock });
    grantId = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "scope-1",
      expires_at: LATER,
    }).grant_id;
    service.registerSourceRef({
      merchant_id: "m-1",
      object_id: "src-1",
      version: 1,
      payload_ref: "payload-1",
      erase_scope_id: "scope-1",
      observed_at: NOW,
      expires_at: LATER,
    });
    actor = createActorContext({
      merchant_id: "m-1",
      actor_id: "admin-1",
      auth_strength: "verified",
      subject_binding: "organization",
      capabilities: ["memory:read", "memory:write"],
    });
    guard = new ContextGuard({
      authority: createGrantBackedAuthority({
        grants,
        bindingEpoch: () => 1,
        dataScopeEpoch: (merchantId, scopeKey) =>
          service.currentDataScopeEpoch(merchantId, scopeKey),
        sourceAvailable: (merchantId, ref) => service.isAvailable(merchantId, ref),
      }),
      now: () => clock,
    });
  });
  afterEach(() => db.close());

  function snapshot(): ContextSnapshot {
    return {
      snapshot_id: "snap-1",
      issued_at: NOW,
      binding_epoch: 1,
      grant_versions: { [grantId]: 1 },
      data_scope_epochs: { "scope-1": 1 },
      memory_set_version: 0,
      conversation_revision: 0,
      config_version: "",
      skill_bindings: [],
    };
  }

  it("删除前快照有效；删除后旧快照在发布前失效（grant_gone / data_scope_gone）", () => {
    const snap = snapshot();
    const check = { actor, snapshot: snap, capability: "memory:read" as const };
    guard.checkRead(check);
    guard.checkPublish(check);

    service.requestDeletion({
      merchant_id: "m-1",
      erase_scope_id: "scope-1",
      requested_by: "admin-1",
      reason: "客户删除",
    });

    try {
      guard.checkPublish(check);
      expect.unreachable("删除后旧快照必须在发布前失效");
    } catch (err) {
      expect(err).toBeInstanceOf(ContextGovernanceError);
      expect((err as ContextGovernanceError).code).toBe("stale_context");
    }
  });

  it("来源删除后 source_refs 检查立即失败；无关来源不受影响", () => {
    service.registerSourceRef({
      merchant_id: "m-1",
      object_id: "src-keep",
      version: 1,
      payload_ref: "payload-keep",
      erase_scope_id: "scope-keep",
      observed_at: NOW,
    });
    const base = { actor, snapshot: snapshot(), capability: "memory:read" as const };
    guard.checkRead({ ...base, source_refs: [{ object_id: "src-1", version: 1 }] });

    service.requestDeletion({
      merchant_id: "m-1",
      erase_scope_id: "scope-1",
      requested_by: "admin-1",
      reason: "客户删除",
    });

    try {
      guard.checkToolCall({
        ...base,
        source_refs: [{ object_id: "src-1", version: 1 }],
      });
      expect.unreachable("已删除来源必须 source_unavailable");
    } catch (err) {
      expect((err as ContextGovernanceError).code).toBe("stale_context");
    }
    // 去掉绑定已失效的 grant/scope，单独验证来源面：无关来源仍可用。
    const sourceOnly = {
      actor,
      capability: "memory:read" as const,
      snapshot: {
        ...snapshot(),
        grant_versions: {},
        data_scope_epochs: {},
      },
    };
    guard.checkRead({ ...sourceOnly, source_refs: [{ object_id: "src-keep", version: 1 }] });
    try {
      guard.checkRead({ ...sourceOnly, source_refs: [{ object_id: "src-1", version: 1 }] });
      expect.unreachable("已删除来源必须 source_unavailable");
    } catch (err) {
      expect((err as ContextGovernanceError).code).toBe("source_unavailable");
    }
  });
});
