/**
 * TOP1-3 M3-6：接待侧客户记忆工具与运行守卫。
 * 绑定主体/有效 grant 时才开放 recall/search/propose；工具只写 candidate；
 * 运行中撤权/删除使快照失效，模型运行回退确定性路径。
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
import { createActorContext } from "../src/merchant-core/context-governance/actor-context.js";
import { SourceGovernanceService } from "../src/merchant-core/context-governance/source-governance.js";
import { CustomerIdentityService } from "../src/merchant-core/customer-memory/identity.js";
import { GrantRequestService } from "../src/merchant-core/customer-memory/grants.js";
import { CustomerMemoryService } from "../src/merchant-core/customer-memory/memory.js";
import { HistorySearchService } from "../src/merchant-core/customer-memory/history.js";
import { SqliteCustomerMemoryProvider } from "../src/merchant-core/customer-memory/reception-provider.js";
import {
  createPiReceptionRuntime,
  TOOL_PROPOSE_CUSTOMER_MEMORY,
  TOOL_PROPOSE_REPLY,
  TOOL_RECALL_CUSTOMER_CONTEXT,
} from "../src/a2a/reception/agent-runtime.js";
import { InMemoryFactRegistry } from "../src/a2a/reception/publish.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";

const NOW = "2026-11-17T00:00:00.000Z";
const MERCHANT = "m-1";
const IDENTITY = "buyer-1";

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

function manager() {
  return createActorContext({
    merchant_id: MERCHANT,
    actor_id: "admin-1",
    auth_strength: "verified",
    subject_binding: "organization",
    capabilities: ["memory:write", "memory:read"],
  });
}

function buyer() {
  return createActorContext({
    merchant_id: MERCHANT,
    actor_id: IDENTITY,
    auth_strength: "session",
    subject_binding: "none",
    capabilities: ["customer:self"],
  });
}

describe("接待客户记忆工具（M3-6）", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let provider: SqliteCustomerMemoryProvider;
  let identity: CustomerIdentityService;
  let grants: GrantRequestService;
  let memory: CustomerMemoryService;
  let history: HistorySearchService;
  let subjectId: string;
  const scope = "org-scope-rec";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-m3-tools-"));
    dbPath = join(dir, "state.sqlite");
    db = new DatabaseSync(dbPath);
    registerGovernanceLedgers(db);
    const now = () => NOW;
    const source = new SourceGovernanceService({ db, now });
    identity = new CustomerIdentityService({ db, now });
    grants = new GrantRequestService({ db, now });
    memory = new CustomerMemoryService({ db, now, sourceGovernance: source, identity });
    history = new HistorySearchService({ db, now });
    subjectId = identity.createSubject({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_kind: "agent_scope",
    }).subject_id;
    const challenge = identity.linkChallenge({
      merchant_id: MERCHANT,
      actor: buyer(),
      source_session_id: "session-1",
      target_subject_id: subjectId,
    });
    identity.linkConfirm({
      merchant_id: MERCHANT,
      actor: buyer(),
      challenge_id: challenge.challenge_id,
      source_session_id: "session-1",
      proof: challenge.proof,
    });
    for (const purpose of ["customer_memory", "history_recall"] as const) {
      const request = grants.createGrantRequest({
        merchant_id: MERCHANT,
        actor: manager(),
        subject_id: subjectId,
        purpose,
        resource_scope_id: scope,
        grant_ttl_seconds: 30 * 24 * 60 * 60,
      });
      grants.confirmGrant({
        merchant_id: MERCHANT,
        actor: buyer(),
        grant_request_id: request.grant_request.grant_request_id,
        confirmation_phrase: request.confirmation_phrase,
      });
    }
    const candidate = memory.proposeMemory({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: subjectId,
      resource_scope_id: scope,
      namespace: "preference",
      key: "unit",
      value_ref: "箱",
      value_type: "enum",
      source_kind: "explicit",
    });
    memory.confirmMemory({
      merchant_id: MERCHANT,
      actor: buyer(),
      memory_id: candidate.memory_id,
      expected_version: 1,
    });
    history.indexHistoryDocument({
      merchant_id: MERCHANT,
      subject_id: subjectId,
      kind: "prior_inquiry",
      sku: "SKU-1",
      occurred_at: NOW,
      source_version: 1,
      text: "客户询问纸箱包装与单位换算",
      grant_id: "unused",
      erase_scope_id: scope,
    });
    provider = new SqliteCustomerMemoryProvider({ dbPath, now });
  });
  afterEach(() => {
    provider.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("contextFor 返回绑定主体/授权版本/记忆版本；无绑定返回 undefined", () => {
    const context = provider.contextFor(MERCHANT, IDENTITY);
    expect(context).toMatchObject({
      merchant_id: MERCHANT,
      subject_id: subjectId,
      binding_epoch: 1,
      memory_set_version: 1,
      resource_scope_id: scope,
    });
    expect(Object.keys(context!.grant_versions)).toHaveLength(2);
    expect(context!.data_scope_epochs[scope]).toBe(1);
    expect(provider.contextFor(MERCHANT, "unknown-buyer")).toBeUndefined();
    expect(provider.recall(context!)[0]).toMatchObject({ key: "unit", value_ref: "箱" });
    expect(provider.search(context!, { query: "纸箱包装" }).status).toBe("ok");
    const proposed = provider.propose(context!, {
      namespace: "constraint",
      key: "delivery",
      value_ref: "上海",
      value_type: "region",
      source_kind: "explicit",
    });
    expect(proposed.state).toBe("candidate");
  });

  it("运行时可 recall/propose；提案保持 candidate；工具计入调用", async () => {
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_RECALL_CUSTOMER_CONTEXT, {} as JsonObject)]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_CUSTOMER_MEMORY, {
          namespace: "constraint",
          key: "delivery",
          value_ref: "上海",
          value_type: "region",
          source_kind: "explicit",
        } as JsonObject),
      ]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_REPLY, {
          blocks: [{ kind: "next_step", action: "send_rfq" }],
        } as unknown as JsonObject),
      ]),
    ]);
    const runtime = createPiReceptionRuntime({
      streamFn,
      model,
      customerProvider: provider,
      maxSteps: 6,
      timeoutMs: 5_000,
    });
    const result = await runtime.run({
      merchantId: MERCHANT,
      identity: IDENTITY,
      contextId: "ctx-memory",
      text: "还是上次那款，先两盒",
      registry: new InMemoryFactRegistry(),
      now: NOW,
    });
    expect(result?.plan.blocks).toEqual([{ kind: "next_step", action: "send_rfq" }]);
    expect(result?.metrics.toolCalls[TOOL_RECALL_CUSTOMER_CONTEXT]).toBe(1);
    expect(result?.metrics.toolCalls[TOOL_PROPOSE_CUSTOMER_MEMORY]).toBe(1);
  });

  it("运行中撤权：工具/发布门守卫失败，运行返回 undefined", async () => {
    const base = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_RECALL_CUSTOMER_CONTEXT, {} as JsonObject)]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_REPLY, {
          blocks: [{ kind: "next_step", action: "send_rfq" }],
        } as unknown as JsonObject),
      ]),
    ]);
    let revoked = false;
    const streamFn = ((...args: Parameters<typeof base.streamFn>) => {
      if (!revoked) {
        revoked = true;
        const writer = new DatabaseSync(dbPath);
        try {
          writer.prepare("UPDATE data_grants SET status = 'REVOKED'").run();
        } finally {
          writer.close();
        }
      }
      return base.streamFn(...args);
    }) as typeof base.streamFn;
    const runtime = createPiReceptionRuntime({
      streamFn,
      model,
      customerProvider: provider,
      maxSteps: 6,
      timeoutMs: 5_000,
    });
    const result = await runtime.run({
      merchantId: MERCHANT,
      identity: IDENTITY,
      contextId: "ctx-revoke-grant",
      text: "查看我的偏好",
      registry: new InMemoryFactRegistry(),
      now: NOW,
    });
    expect(result).toBeUndefined();
  });
});
