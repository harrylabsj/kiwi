/**
 * TOP1-3 M3-6：接待侧客户记忆工具与运行守卫。
 * 绑定主体/有效 grant 时才开放 recall/search/propose；工具只写 candidate；
 * 运行中撤权/删除使快照失效，模型运行回退确定性路径。
 */
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

import { loadProfile } from "../src/config/profile.js";
import { writeAdminCredentials } from "../src/auth/merchant-sessions.js";
import { startStandaloneMerchantWorkbench } from "../src/merchant/workbench-server.js";
import { startMemoryProposalServer, requestMemoryProposal } from "../src/merchant-core/customer-memory/private-transport.js";
import { createReceptionMemoryWriter } from "../src/merchant-core/customer-memory/reception-writer.js";
import { initializeGovernanceRuntime } from "../src/merchant-core/ownership/runtime.js";
import { parseGovernanceFeatureFlags } from "../src/merchant-core/context-governance/feature-flags.js";
import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
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

  it("contextFor 返回绑定主体/授权版本/记忆版本；无绑定返回 undefined", async () => {
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
    const proposed = await provider.propose(context!, {
      namespace: "constraint",
      key: "delivery",
      value_ref: "上海",
      value_type: "region",
      source_kind: "explicit",
    });
    expect(proposed.state).toBe("candidate");
  });

  it("私有通道由 fenced 工作台核验并写入；失效快照和失权均拒绝", async () => {
    migrateMerchantOpsSchema(db);
    const runtime = initializeGovernanceRuntime({ db, merchantId: MERCHANT, ownerId: "workbench", flags: parseGovernanceFeatureFlags({ memory_enabled: true }), now: () => NOW, heartbeatMs: 3_600_000 });
    const writer = createReceptionMemoryWriter({ db, merchantId: MERCHANT, now: () => NOW, write: (work) => runtime.writeUnderOwnership(work) });
    const socketPath = join(dir, "memory.sock");
    const server = await startMemoryProposalServer(socketPath, writer);
    const context = provider.contextFor(MERCHANT, IDENTITY)!;
    const input = { namespace: "constraint" as const, key: "delivery", value_ref: "上海", value_type: "region", source_kind: "inferred" as const };
    try {
      const result = await requestMemoryProposal(socketPath, context, input);
      expect(result.state).toBe("needs_review");
      expect(db.prepare("SELECT value_ref FROM customer_memories WHERE memory_id = ?").get(result.memory_id)).toMatchObject({ value_ref: "上海" });
      await expect(startMemoryProposalServer(socketPath, () => { throw new Error("unexpected"); })).rejects.toThrow("already exists");
      await expect(requestMemoryProposal(socketPath, { ...context, binding_epoch: context.binding_epoch + 1 }, input)).rejects.toThrow();
      await expect(requestMemoryProposal(socketPath, { ...context, merchant_id: "other" }, input)).rejects.toThrow();
      await expect(requestMemoryProposal(socketPath, { ...context, grant_versions: {} }, input)).rejects.toThrow();
      await expect(requestMemoryProposal(socketPath, { ...context, data_scope_epochs: {} }, input)).rejects.toThrow();
      runtime.stop();
      await expect(requestMemoryProposal(socketPath, context, input)).rejects.toThrow();
    } finally {
      runtime.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("独立工作台接收只读接待进程的提案，关闭后拒绝写入", async () => {
    const socketPath = join(dir, "memory.sock");
    const profilePath = join(dir, "profile.yaml");
    writeFileSync(profilePath, `runtime_version: 0.5.0
protocol_version: shopping.negotiation/0.1
agent_id: merchant-agent:m-1
role: merchant
owner_id: m-1
commerce:
  base_url: http://127.0.0.1:8765
  token_env: SHOPPING_AGENT_TOKEN
  backend: local_marketplace
model:
  provider: fake
  model: fake-merchant-model
runtime:
  mode: once
  poll_interval_seconds: 5
  turn_timeout_seconds: 90
  max_model_steps: 4
  max_retries: 2
merchant_policy:
  delivery_lead_days: 7
`);
    const profile = loadProfile(profilePath);
    writeAdminCredentials(dir, { principalId: profile.agent_id, merchantId: MERCHANT, password: "strong-pw-123" });
    process.env.KIWI_GOVERNANCE_MEMORY_ENABLED = "true";
    process.env.KIWI_MEMORY_SOCKET_PATH = socketPath;
    let handle: Awaited<ReturnType<typeof startStandaloneMerchantWorkbench>>;
    try {
      handle = await startStandaloneMerchantWorkbench({ profile, dataDir: dir, host: "127.0.0.1", port: 0, log: () => undefined });
    } finally {
      delete process.env.KIWI_GOVERNANCE_MEMORY_ENABLED;
      delete process.env.KIWI_MEMORY_SOCKET_PATH;
    }
    const readOnly = new SqliteCustomerMemoryProvider({ dbPath, now: () => NOW, allowWrites: false, socketPath });
    try {
      const context = readOnly.contextFor(MERCHANT, IDENTITY)!;
      const input = { namespace: "constraint" as const, key: "region", value_ref: "上海", value_type: "region", source_kind: "explicit" as const };
      expect(readOnly.canPropose(context)).toBe(true);
      const result = await readOnly.propose(context, input);
      expect(db.prepare("SELECT value_ref FROM customer_memories WHERE memory_id = ?").get(result.memory_id)).toMatchObject({ value_ref: "上海" });
      await handle.close();
      const before = db.prepare("SELECT count(*) AS n FROM customer_memories").get();
      await expect(readOnly.propose(context, input)).rejects.toThrow();
      expect(db.prepare("SELECT count(*) AS n FROM customer_memories").get()).toEqual(before);
    } finally {
      readOnly.close();
      await handle.close();
    }
  });

  it("私有通道按字节处理拆分中文并拒绝超大请求", async () => {
    const socketPath = join(dir, "memory.sock");
    let calls = 0;
    let captured = "";
    const server = await startMemoryProposalServer(socketPath, (_context, input) => {
      calls += 1;
      captured = input.value_ref;
      return { memory_id: "mem-test", state: "candidate" };
    });
    async function send(chunks: Buffer[]): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.on("connect", () => { for (const chunk of chunks) socket.write(chunk); socket.end(); });
        socket.on("data", () => undefined);
        socket.on("end", resolve);
        socket.on("close", () => resolve());
        socket.on("error", reject);
      });
    }
    try {
      const body = Buffer.from(JSON.stringify({ context: {}, input: { value_ref: "上海" } }));
      const start = body.indexOf(Buffer.from("上"));
      await send([body.subarray(0, start + 1), body.subarray(start + 1)]);
      expect(captured).toBe("上海");
      await send([Buffer.alloc(20_000, 32)]);
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("无写通道或仅历史授权时禁用提案能力", () => {
    const readOnly = new SqliteCustomerMemoryProvider({ dbPath, now: () => NOW, allowWrites: false });
    const socketProvider = new SqliteCustomerMemoryProvider({ dbPath, now: () => NOW, allowWrites: false, socketPath: join(dir, "memory.sock") });
    try {
      expect(readOnly.canPropose(readOnly.contextFor(MERCHANT, IDENTITY)!)).toBe(false);
      db.prepare("UPDATE data_grants SET status = 'REVOKED' WHERE purpose = 'customer_memory'").run();
      expect(socketProvider.canPropose(socketProvider.contextFor(MERCHANT, IDENTITY)!)).toBe(false);
    } finally { readOnly.close(); socketProvider.close(); }
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
