/**
 * TOP1 M2-6：接待技能目录与加载（设计 §7.1 / D-M0-04）。
 * 只返回生效指针 ACTIVE 版本；摘要 ≤5 项/600 字；load 只接受快照绑定产物；
 * 撤回/退役后立即不可见；运行期四检查点守卫阻断旧快照。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { LearningRepository } from "../src/merchant-core/learning/repository.js";
import { SqliteReceptionSkillCatalog } from "../src/merchant-core/learning/reception-skill-catalog.js";
import {
  createPiReceptionRuntime,
  TOOL_LOAD_RECEPTION_SKILL,
  TOOL_PROPOSE_REPLY,
} from "../src/a2a/reception/agent-runtime.js";
import { InMemoryFactRegistry } from "../src/a2a/reception/publish.js";
import { MAX_SKILL_SUMMARIES } from "../src/a2a/reception/skill-catalog.js";
import { compileReceptionSkillArtifact } from "../src/a2a/reception/skill-contract.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";
import type { SkillRelease } from "../src/merchant-core/learning/types.js";

const NOW = "2026-11-17T00:00:00.000Z";
const MERCHANT = "m-1";

const model = {
  id: "fake-model",
  name: "fake-model",
  api: "openai-completions",
  provider: "fake",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<Api>;

describe("接待技能目录（M2-6）", () => {
  let dir: string;
  let dbPath: string;
  let catalog: SqliteReceptionSkillCatalog;
  let counter = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-m2-skill-"));
    dbPath = join(dir, "state.sqlite");
    catalog = new SqliteReceptionSkillCatalog({ dbPath });
  });
  afterEach(() => {
    catalog.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(input: {
    skillKey: string;
    trigger?: string;
    steps?: readonly unknown[];
    active?: boolean;
    state?: "ACTIVE" | "RETIRED" | "REVOKED";
  }): SkillRelease {
    counter += 1;
    const db = new DatabaseSync(dbPath);
    try {
      registerGovernanceLedgers(db);
      const compiled = compileReceptionSkillArtifact({
        skill_key: input.skillKey,
        steps: input.steps ?? [{ action_ref: "get_commercial_facts" }],
      });
      const generation = counter;
      const release: SkillRelease = {
        release_id: `rel_${counter}`,
        merchant_id: MERCHANT,
        skill_key: input.skillKey,
        trigger_text: input.trigger ?? "单位不明确时先读取商家规则",
        generation,
        state: input.state ?? "ACTIVE",
        artifact_hash: compiled.artifact_hash,
        content_hash: `sha256:content-${counter}`,
        compiled_artifact: compiled.artifact,
        candidate_id: `cand_${counter}`,
        candidate_revision: 1,
        compiler_version: compiled.compiler_version,
        question_schema_version: 1,
        tool_contract_digest: compiled.tool_contract_digest,
        eval_report_id: `eval_${counter}`,
        approval_ref: `apr_${counter}`,
        revocation_epoch: input.state === "REVOKED" ? 1 : 0,
        retired_at: null,
        revoked_at: null,
        created_at: NOW,
        updated_at: NOW,
      };
      const repository = new LearningRepository({ db });
      repository.insertRelease(release);
      if (input.active !== false) {
        repository.upsertPointer({
          merchant_id: MERCHANT,
          skill_key: input.skillKey,
          release_id: release.release_id,
          generation,
          updated_at: NOW,
        });
      }
      return release;
    } finally {
      db.close();
    }
  }

  it("只返回生效指针且 ACTIVE 的版本；load 只接受绑定 release", () => {
    const release = seed({ skillKey: "trial-unit-clarification" });
    const retired = seed({
      skillKey: "price-objection",
      active: false,
      state: "RETIRED",
    });
    const bindings = catalog.activeBindings(MERCHANT);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      skill_key: "trial-unit-clarification",
      release_id: release.release_id,
      compiled_artifact_hash: release.artifact_hash,
    });
    expect(bindings[0]!.body_text).toContain("1. get_commercial_facts");
    expect(catalog.currentBinding(MERCHANT, "trial-unit-clarification")).toMatchObject({
      release_id: release.release_id,
    });
    expect(catalog.currentBinding(MERCHANT, "price-objection")).toBeUndefined();
    expect(
      catalog.loadArtifact(MERCHANT, "trial-unit-clarification", release.release_id),
    ).toBeDefined();
    // RETIRED 不再分配给新运行，但已固定快照的运行仍可加载（A10）。
    expect(catalog.loadArtifact(MERCHANT, "price-objection", retired.release_id)).toBeDefined();
    // 跨商家空目录。
    expect(catalog.activeBindings("m-2")).toEqual([]);
  });

  it("A10：普通升级不混版本；已固定旧版本的运行可继续加载", () => {
    const first = seed({ skillKey: "trial-unit-clarification" });
    const second = seed({ skillKey: "trial-unit-clarification" });
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE skill_releases SET state = 'RETIRED' WHERE release_id = ?").run(
        first.release_id,
      );
    } finally {
      db.close();
    }
    const bindings = catalog.activeBindings(MERCHANT);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.release_id).toBe(second.release_id);
    expect(catalog.currentBinding(MERCHANT, "trial-unit-clarification")?.release_id).toBe(
      second.release_id,
    );
    // 老运行 pinned 的 release 仍可加载，不因升级中断。
    expect(
      catalog.loadArtifact(MERCHANT, "trial-unit-clarification", first.release_id),
    ).toBeDefined();
    expect(
      catalog.loadArtifact(MERCHANT, "trial-unit-clarification", second.release_id),
    ).toBeDefined();
  });

  it("撤回/退役后立即不可见", () => {
    const release = seed({ skillKey: "trial-unit-clarification" });
    expect(catalog.activeBindings(MERCHANT)).toHaveLength(1);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        "UPDATE skill_active_pointers SET release_id = NULL WHERE merchant_id = ? AND skill_key = ?",
      ).run(MERCHANT, "trial-unit-clarification");
    } finally {
      db.close();
    }
    expect(catalog.activeBindings(MERCHANT)).toEqual([]);
    // 指针清空不影响已固定该 release 的在途运行加载；REVOKED 才阻断。
    expect(
      catalog.loadArtifact(MERCHANT, "trial-unit-clarification", release.release_id),
    ).toBeDefined();
  });

  it("摘要最多 5 项 / 600 字并标记截断；不含正文", () => {
    for (let index = 0; index < 6; index++) {
      seed({
        skillKey: `skill-${index}`,
        trigger: "单位不明确时先读取商家规则并追问".repeat(3),
      });
    }
    const result = catalog.summaries(MERCHANT);
    expect(result.summaries.length).toBeLessThanOrEqual(MAX_SKILL_SUMMARIES);
    expect(result.truncated).toBe(true);
    const text = result.summaries.map((item) => `${item.skill_key}${item.trigger}`).join("");
    expect(text.length).toBeLessThanOrEqual(600);
    expect(JSON.stringify(result)).not.toContain("get_commercial_facts");
  });
});

describe("运行期技能加载与守卫", () => {
  let dir: string;
  let dbPath: string;
  let catalog: SqliteReceptionSkillCatalog;
  let skillKey: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-m2-skill-run-"));
    dbPath = join(dir, "state.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      registerGovernanceLedgers(db);
      const compiled = compileReceptionSkillArtifact({
        skill_key: "trial-unit-clarification",
        steps: [
          { action_ref: "get_commercial_facts" },
          { action_ref: "ask_registered_question", question_id: "q_unit_mismatch_v1", guard_ref: "unit_unresolved" },
        ],
      });
      const repository = new LearningRepository({ db });
      repository.insertRelease({
        release_id: "rel_run",
        merchant_id: "m-1",
        skill_key: "trial-unit-clarification",
        trigger_text: "单位不明确时先读单位规则",
        generation: 1,
        state: "ACTIVE",
        artifact_hash: compiled.artifact_hash,
        content_hash: "sha256:content-run",
        compiled_artifact: compiled.artifact,
        candidate_id: "cand_run",
        candidate_revision: 1,
        compiler_version: compiled.compiler_version,
        question_schema_version: 1,
        tool_contract_digest: compiled.tool_contract_digest,
        eval_report_id: "eval_run",
        approval_ref: "apr_run",
        revocation_epoch: 0,
        retired_at: null,
        revoked_at: null,
        created_at: NOW,
        updated_at: NOW,
      });
      repository.upsertPointer({
        merchant_id: "m-1",
        skill_key: "trial-unit-clarification",
        release_id: "rel_run",
        generation: 1,
        updated_at: NOW,
      });
    } finally {
      db.close();
    }
    skillKey = "trial-unit-clarification";
    catalog = new SqliteReceptionSkillCatalog({ dbPath });
  });
  afterEach(() => {
    catalog.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function runtimeWith(streamFn: ReturnType<typeof createScriptedFakeStreamFn>["streamFn"]) {
    return createPiReceptionRuntime({
      streamFn,
      model,
      skillCatalog: catalog,
      maxSteps: 6,
      timeoutMs: 5_000,
    });
  }

  it("快照摘要进入 context，模型可加载绑定技能并继续回复", async () => {
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([
        fauxToolCall(TOOL_LOAD_RECEPTION_SKILL, { skill_key: skillKey } as JsonObject),
      ]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_REPLY, {
          blocks: [{ kind: "next_step", action: "send_rfq" }],
        } as unknown as JsonObject),
      ]),
    ]);
    const runtime = runtimeWith(streamFn);
    const result = await runtime.run({
      merchantId: "m-1",
      identity: "buyer-1",
      contextId: "ctx-skill",
      text: "这个一箱多少钱",
      registry: new InMemoryFactRegistry(),
      now: NOW,
    });
    expect(result?.plan.blocks).toEqual([{ kind: "next_step", action: "send_rfq" }]);
    expect(result?.metrics.toolCalls[TOOL_LOAD_RECEPTION_SKILL]).toBe(1);
    // A17 审计：记录实际加载的 skill_key 与冻结 release。
    expect(result?.metrics.loadedSkills).toEqual([
      { skill_key: skillKey, release_id: "rel_run", accepted: true },
    ]);
  });

  it("A19：第 3 次加载被拒绝（max_skills），不静默截断并记录原因", async () => {
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([
        fauxToolCall(TOOL_LOAD_RECEPTION_SKILL, { skill_key: skillKey } as JsonObject),
      ]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_LOAD_RECEPTION_SKILL, { skill_key: skillKey } as JsonObject),
      ]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_LOAD_RECEPTION_SKILL, { skill_key: skillKey } as JsonObject),
      ]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_REPLY, {
          blocks: [{ kind: "next_step", action: "send_rfq" }],
        } as unknown as JsonObject),
      ]),
    ]);
    const runtime = runtimeWith(streamFn);
    const result = await runtime.run({
      merchantId: "m-1",
      identity: "buyer-1",
      contextId: "ctx-skill-limit",
      text: "这个一箱多少钱",
      registry: new InMemoryFactRegistry(),
      now: NOW,
    });
    expect(result?.metrics.toolCalls[TOOL_LOAD_RECEPTION_SKILL]).toBe(3);
    expect(result?.metrics.loadedSkills).toEqual([
      { skill_key: skillKey, release_id: "rel_run", accepted: true },
      { skill_key: skillKey, release_id: "rel_run", accepted: true },
      { skill_key: skillKey, release_id: "rel_run", accepted: false, reason: "max_skills" },
    ]);
  });

  it("运行中技能被撤回：工具/发布门守卫失败，运行返回 undefined（引擎回退确定性）", async () => {
    const base = createScriptedFakeStreamFn([
      fauxAssistantMessage([
        fauxToolCall(TOOL_LOAD_RECEPTION_SKILL, { skill_key: skillKey } as JsonObject),
      ]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_REPLY, {
          blocks: [{ kind: "next_step", action: "send_rfq" }],
        } as unknown as JsonObject),
      ]),
    ]);
    let cleared = false;
    const streamFn = ((...args: Parameters<typeof base.streamFn>) => {
      if (!cleared) {
        cleared = true;
        const db = new DatabaseSync(dbPath);
        try {
          db.prepare("UPDATE skill_active_pointers SET release_id = NULL").run();
        } finally {
          db.close();
        }
      }
      return base.streamFn(...args);
    }) as typeof base.streamFn;
    const runtime = runtimeWith(streamFn);
    const result = await runtime.run({
      merchantId: "m-1",
      identity: "buyer-1",
      contextId: "ctx-revoke",
      text: "这个一箱多少钱",
      registry: new InMemoryFactRegistry(),
      now: NOW,
    });
    expect(result).toBeUndefined();
  });
});
