/**
 * TOP1-3 M1：ContextGuard 四个检查点（读取/工具/provider attempt/发布）。
 * §4.3：四个检查点分别检查权限、来源可用性与版本——capability 全部必查；
 * 主体绑定一致性 + binding_epoch 实际校验（撤销绑定使旧快照失效）；
 * grant epoch、来源可用性、配置/技能/会话版本；旧快照一律 fail-closed。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { DataUseGrantStore } from "../src/merchant-core/context-governance/data-use-grant.js";
import { createGrantBackedAuthority } from "../src/merchant-core/context-governance/authority.js";
import {
  ContextGuard,
  type ContextGuardCheckInput,
  type ContextSnapshot,
  type SourceRefCheck,
} from "../src/merchant-core/context-governance/context-guard.js";
import { createActorContext } from "../src/merchant-core/context-governance/actor-context.js";
import { ContextGovernanceError } from "../src/merchant-core/context-governance/types.js";

const NOW = "2026-11-15T00:00:00.000Z";
const LATER = "2026-12-15T00:00:00.000Z";

describe("ContextGuard（设计 §4.3）", () => {
  let db: DatabaseSync;
  let grants: DataUseGrantStore;
  let guard: ContextGuard;
  let actor: ReturnType<typeof createActorContext>;
  let grantId: string;
  let configVersion: string;
  let bindingEpoch: number | undefined;
  let memorySetVersion: number;
  const clock = (): string => NOW;
  const okSource: SourceRefCheck = { object_id: "src-ok", version: 3 };

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    migrateMerchantOpsSchema(db);
    registerGovernanceLedgers(db);
    grants = new DataUseGrantStore({ db, now: clock });
    grantId = grants
      .createGrant({
        merchant_id: "m-1",
        subject_id: "subj-1",
        purpose: "customer_memory",
        resource_scope_id: "org",
        expires_at: LATER,
      })
      .grant_id;
    configVersion = "cfg-1";
    bindingEpoch = 1;
    memorySetVersion = 0;
    actor = createActorContext({
      merchant_id: "m-1",
      actor_id: "runtime-1",
      auth_strength: "session",
      subject_binding: "agent_scope",
      capabilities: ["memory:read", "memory:write", "reception:serve"],
    });
    guard = new ContextGuard({
      authority: createGrantBackedAuthority({
        grants,
        bindingEpoch: () => bindingEpoch,
        configVersion: () => configVersion,
        memorySetVersion: () => memorySetVersion,
        sourceAvailable: (_merchantId, ref) =>
          ref.object_id === "src-ok" && ref.erased !== true,
        skillBinding: (_merchantId, skillKey) =>
          skillKey === "trial-unit-clarification"
            ? {
                release_id: "rel-1",
                compiled_artifact_hash: "sha256:auth-1",
                generation: 1,
                revocation_epoch: 0,
              }
            : undefined,
      }),
      now: clock,
    });
  });
  afterEach(() => db.close());

  function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
    return {
      snapshot_id: "snap-1",
      issued_at: NOW,
      binding_epoch: 1,
      grant_versions: { [grantId]: 1 },
      data_scope_epochs: {},
      memory_set_version: 0,
      conversation_revision: 0,
      config_version: "cfg-1",
      skill_bindings: [],
      ...overrides,
    };
  }

  function expectFail(fn: () => void, code: string, reason: string): void {
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

  it("快照有效时四个检查点全部通过", () => {
    const snap = snapshot();
    guard.checkRead({ actor, snapshot: snap, capability: "memory:read", source_refs: [okSource] });
    guard.checkToolCall({
      actor,
      snapshot: snap,
      capability: "memory:write",
      tool: "recall_customer_context",
      source_refs: [okSource],
    });
    guard.checkProviderAttempt({ actor, snapshot: snap, capability: "memory:read", source_refs: [okSource] });
    guard.checkPublish({ actor, snapshot: snap, capability: "memory:write", source_refs: [okSource] });
  });

  it("§4.3 权限必查：read/provider/publish 缺 capability 一律 validation，无旁路", () => {
    const snap = snapshot();
    // 类型上 capability 必填；用 cast 模拟调用方漏传。
    const missing = (snap_input: Omit<ContextGuardCheckInput, "capability">) =>
      snap_input as ContextGuardCheckInput;
    expectFail(
      () => guard.checkRead(missing({ actor, snapshot: snap })),
      "validation",
      "capability_required",
    );
    expectFail(
      () => guard.checkProviderAttempt(missing({ actor, snapshot: snap })),
      "validation",
      "capability_required",
    );
    expectFail(
      () => guard.checkPublish(missing({ actor, snapshot: snap })),
      "validation",
      "capability_required",
    );
    expectFail(
      () => guard.checkToolCall(missing({ actor, snapshot: snap })),
      "validation",
      "capability_required",
    );
    expectFail(
      () => guard.checkRead({ actor, snapshot: snap, capability: "jobs:manage" }),
      "access_denied",
      "capability_missing",
    );
  });

  it("主体绑定一致性：绑定态必须携带 binding_epoch，匿名不得携带", () => {
    // agent_scope actor + 快照 binding_epoch 0 → 不一致。
    expectFail(
      () => guard.checkRead({ actor, snapshot: snapshot({ binding_epoch: 0 }), capability: "memory:read" }),
      "validation",
      "binding_state_inconsistent",
    );
    // 匿名 actor + 快照 binding_epoch 1 → 不一致（匿名 actor 具备能力，
    // 排除能力检查先行报错，确保失败确由绑定一致性引起）。
    const anonymous = createActorContext({
      merchant_id: "m-1",
      actor_id: "anon-1",
      auth_strength: "anonymous",
      subject_binding: "none",
      capabilities: ["memory:read"],
    });
    expectFail(
      () =>
        guard.checkRead({
          actor: anonymous,
          snapshot: snapshot({ binding_epoch: 1 }),
          capability: "memory:read",
        }),
      "validation",
      "binding_state_inconsistent",
    );
    // 匿名 actor + binding_epoch 0 → 合法，不做绑定查询。
    guard.checkRead({
      actor: anonymous,
      snapshot: snapshot({ binding_epoch: 0, grant_versions: {} }),
      capability: "memory:read",
    });
  });

  it("binding_epoch 实际校验：撤销绑定 → binding_gone；重新绑定 → epoch 变化失效", () => {
    guard.checkRead({ actor, snapshot: snapshot(), capability: "memory:read" });

    // 撤销绑定（§9.2）：authority 回答 undefined → 旧快照失效。
    bindingEpoch = undefined;
    expectFail(
      () => guard.checkRead({ actor, snapshot: snapshot(), capability: "memory:read" }),
      "stale_context",
      "binding_gone",
    );
    // 重新绑定创建新 binding：epoch 递增 → 旧快照仍失效。
    bindingEpoch = 2;
    expectFail(
      () => guard.checkPublish({ actor, snapshot: snapshot(), capability: "memory:write" }),
      "stale_context",
      "binding_epoch_changed",
    );
    // 新快照绑定当前 epoch → 通过。
    guard.checkRead({ actor, snapshot: snapshot({ binding_epoch: 2 }), capability: "memory:read" });
  });

  it("grant 撤权后旧快照失效：grant_gone；epoch 失配分支（自定义 authority）", () => {
    grants.revokeGrant({ merchant_id: "m-1", grant_id: grantId, expected_epoch: 1 });
    expectFail(
      () => guard.checkRead({ actor, snapshot: snapshot(), capability: "memory:read" }),
      "stale_context",
      `grant_gone:${grantId}`,
    );

    const regrant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: LATER,
    });
    // 撤销递增 epoch（§17.1）：被撤记录 epoch 1→2，重新授权拿到 3。
    expect(regrant.grant_epoch).toBe(3);
    expectFail(
      () => guard.checkRead({ actor, snapshot: snapshot(), capability: "memory:read" }),
      "stale_context",
      `grant_gone:${grantId}`,
    );
    guard.checkRead({
      actor,
      snapshot: snapshot({ grant_versions: { [regrant.grant_id]: 3 } }),
      capability: "memory:read",
    });

    // epoch 失配分支（供非 grant 存储的 authority 复用同一守卫规则）：
    const drifting = new ContextGuard({
      authority: {
        currentGrantEpoch: (_m, _g) => 2,
        currentBindingEpoch: () => 1,
        currentDataScopeEpoch: () => undefined,
        currentSkillBinding: () => undefined,
        currentMemorySetVersion: () => undefined,
        currentConversationRevision: () => undefined,
        currentConfigVersion: () => configVersion,
        sourceAvailable: () => false,
      },
      now: clock,
    });
    expectFail(
      () => drifting.checkRead({ actor, snapshot: snapshot(), capability: "memory:read" }),
      "stale_context",
      "grant_epoch_changed",
    );
  });

  it("B08：纠错后 memory_set_version 变化，旧上下文的 provider/发布被阻断", () => {
    memorySetVersion = 1;
    const snap = snapshot({ memory_set_version: 1 });
    guard.checkProviderAttempt({
      actor,
      snapshot: snap,
      capability: "memory:read",
      source_refs: [okSource],
    });
    memorySetVersion = 2;
    expectFail(
      () =>
        guard.checkProviderAttempt({
          actor,
          snapshot: snap,
          capability: "memory:read",
          source_refs: [okSource],
        }),
      "stale_context",
      "memory_set_version_changed",
    );
    expectFail(
      () =>
        guard.checkPublish({
          actor,
          snapshot: snap,
          capability: "memory:write",
          source_refs: [okSource],
        }),
      "stale_context",
      "memory_set_version_changed",
    );
  });

  it("来源不可用/封存/过期 → source_unavailable", () => {
    expectFail(
      () =>
        guard.checkRead({
          actor,
          snapshot: snapshot(),
          capability: "memory:read",
          source_refs: [{ object_id: "src-gone", version: 1 }],
        }),
      "source_unavailable",
      "source:src-gone",
    );
    expectFail(
      () =>
        guard.checkPublish({
          actor,
          snapshot: snapshot(),
          capability: "memory:write",
          source_refs: [{ object_id: "src-ok", version: 3, erased: true }],
        }),
      "source_unavailable",
      "source:src-ok",
    );
  });

  it("配置版本变化 → 发布与 provider attempt 均拒绝（旧上下文失效）", () => {
    const snap = snapshot();
    guard.checkPublish({ actor, snapshot: snap, capability: "memory:write" });
    configVersion = "cfg-2";
    expectFail(
      () => guard.checkPublish({ actor, snapshot: snap, capability: "memory:write" }),
      "stale_context",
      "config_version_changed",
    );
    expectFail(
      () => guard.checkProviderAttempt({ actor, snapshot: snap, capability: "memory:read" }),
      "stale_context",
      "config_version_changed",
    );
    // 新快照绑定新 config → 通过。
    guard.checkPublish({
      actor,
      snapshot: snapshot({ config_version: "cfg-2" }),
      capability: "memory:write",
    });
  });

  it("未注入的域 fail-closed：快照绑定 data scope / 技能 / 会话版本时拒绝", () => {
    // authority 未提供 dataScopeEpoch → 快照一旦绑定即 stale。
    expectFail(
      () =>
        guard.checkRead({
          actor,
          snapshot: snapshot({ data_scope_epochs: { "erase-scope-1": 4 } }),
          capability: "memory:read",
        }),
      "stale_context",
      "data_scope_gone",
    );
    // 未绑定技能的快照不受影响（该域未被快照使用）。
    guard.checkRead({ actor, snapshot: snapshot(), capability: "memory:read" });
  });

  it("技能绑定：release/generation/revocation_epoch/compiled_artifact_hash 逐值一致才通过", () => {
    const bound = snapshot({
      skill_bindings: [
        {
          skill_key: "trial-unit-clarification",
          release_id: "rel-1",
          compiled_artifact_hash: "sha256:auth-1",
          generation: 1,
          revocation_epoch: 0,
        },
      ],
    });
    guard.checkToolCall({ actor, snapshot: bound, capability: "reception:serve" });

    // 撤回：authority 回答 undefined。
    expectFail(
      () =>
        guard.checkToolCall({
          actor,
          snapshot: snapshot({
            skill_bindings: [
              {
                skill_key: "unknown-skill",
                release_id: "rel-1",
                compiled_artifact_hash: "sha256:auth-1",
                generation: 1,
                revocation_epoch: 0,
              },
            ],
          }),
          capability: "reception:serve",
        }),
      "stale_context",
      "skill_unbound:unknown-skill",
    );

    // 版本漂移：revocation_epoch 已递增。
    expectFail(
      () =>
        guard.checkPublish({
          actor,
          snapshot: snapshot({
            skill_bindings: [
              {
                skill_key: "trial-unit-clarification",
                release_id: "rel-1",
                compiled_artifact_hash: "sha256:auth-1",
                generation: 1,
                revocation_epoch: 1,
              },
            ],
          }),
          capability: "reception:serve",
        }),
      "stale_context",
      "skill_version_changed:trial-unit-clarification",
    );

    // 产物漂移（DeepSeek 审查项）：同 release/generation/epoch 但 hash 与权威
    // 冻结值不一致——旧产物借新版本号通过在此拒绝。
    expectFail(
      () =>
        guard.checkPublish({
          actor,
          snapshot: snapshot({
            skill_bindings: [
              {
                skill_key: "trial-unit-clarification",
                release_id: "rel-1",
                compiled_artifact_hash: "sha256:stale-artifact",
                generation: 1,
                revocation_epoch: 0,
              },
            ],
          }),
          capability: "reception:serve",
        }),
      "stale_context",
      "skill_artifact_changed:trial-unit-clarification",
    );

    // 缺 hash 的绑定：形状校验直接拒绝。
    expectFail(
      () =>
        guard.checkRead({
          actor,
          snapshot: snapshot({
            skill_bindings: [
              {
                skill_key: "trial-unit-clarification",
                release_id: "rel-1",
                compiled_artifact_hash: "",
                generation: 1,
                revocation_epoch: 0,
              },
            ],
          }),
          capability: "memory:read",
        }),
      "validation",
      "skill_binding_invalid",
    );
  });

  it("形状错误保留实际检查点（审计要求）", () => {
    try {
      guard.checkPublish({ actor, snapshot: snapshot({ snapshot_id: "" }), capability: "memory:write" });
      expect.unreachable();
    } catch (err) {
      expect((err as ContextGovernanceError).code).toBe("validation");
      expect((err as ContextGovernanceError).reason).toBe("publish.snapshot_id_missing");
    }
    try {
      guard.checkProviderAttempt({
        actor,
        snapshot: snapshot({ issued_at: "2026-11-15T00:00:01.000Z" }),
        capability: "memory:read",
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ContextGovernanceError).reason).toBe("provider_attempt.issued_at_future");
    }
    try {
      guard.checkToolCall({
        actor,
        snapshot: snapshot({ grant_versions: { [grantId]: 0 } }),
        capability: "reception:serve",
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ContextGovernanceError).reason).toContain("tool_call.grant_epoch_invalid:");
    }
  });

  it("会话版本变化拒绝旧需求提案；快照形状非法拒绝", () => {
    expectFail(
      () =>
        guard.checkRead({
          actor,
          snapshot: snapshot({ conversation_revision: 7 }),
          capability: "memory:read",
        }),
      "stale_context",
      "conversation_revision_changed",
    );
    expectFail(
      () =>
        guard.checkRead({
          actor,
          snapshot: snapshot({ grant_versions: { [grantId]: 0 } }),
          capability: "memory:read",
        }),
      "validation",
      "grant_epoch_invalid",
    );
    expectFail(
      () => guard.checkRead({ actor, snapshot: snapshot({ snapshot_id: "" }), capability: "memory:read" }),
      "validation",
      "snapshot_id_missing",
    );
    expectFail(
      () =>
        guard.checkRead({
          actor,
          snapshot: snapshot({ issued_at: "2026-11-15T00:00:01.000Z" }),
          capability: "memory:read",
        }),
      "validation",
      "issued_at_future",
    );
  });

  it("快照未绑定的域不查询：grant_versions 为空时撤权不影响检查", () => {
    const snap = snapshot({ grant_versions: {} });
    grants.revokeGrant({ merchant_id: "m-1", grant_id: grantId, expected_epoch: 1 });
    guard.checkRead({ actor, snapshot: snap, capability: "memory:read" });
    guard.checkProviderAttempt({ actor, snapshot: snap, capability: "memory:read" });
    guard.checkPublish({ actor, snapshot: snap, capability: "memory:write" });
  });
});
