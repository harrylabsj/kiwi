/**
 * AgentKernel + main session integration tests (design §19.1, §18.3):
 * the remember/forget/correct/why closed loop through the model tool path,
 * serial message processing, session persistence and recovery, the
 * no-thinking persistence invariant, physical buyer/merchant isolation,
 * and fail-closed corruption handling.
 *
 * Deterministic: faux providers, temp agent dirs, injected clock.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { ensurePathsForDir } from "../src/agent/agent-db.js";
import {
  FakeCommerceConnector,
  fakeConnectorProduct,
} from "../src/agent/connector/fake-connector.js";
import { createFakeChatModels } from "../src/agent/fake-chat-model.js";
import { AgentKernel } from "../src/agent/kernel.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import { AgentSessionError } from "../src/agent/session.js";
import { testBuyerProfile, testProfile } from "./helpers.js";

const TEST_KEY = "a".repeat(64);

let workDir: string;

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.KIWI_DATA_KEY;
});

function pathsFor(name: string) {
  return ensurePathsForDir(path.join(workDir, name));
}

function scriptedChatModels(steps: FauxResponseStep[]): {
  models: MutableModels;
  model: Model<string>;
} {
  const handle = fauxProvider({ models: [{ id: "fake-chat-model", name: "fake-chat-model" }] });
  handle.setResponses(steps);
  const models = createModels();
  models.setProvider(handle.provider);
  return { models, model: handle.getModel() };
}

async function openKernel(
  name: string,
  options: {
    steps?: FauxResponseStep[];
    vault?: PrivateVault;
    buyer?: boolean;
  } = {},
): Promise<AgentKernel> {
  const { models, model } = options.steps
    ? scriptedChatModels(options.steps)
    : createFakeChatModels();
  return AgentKernel.open({
    profile: options.buyer === true ? testBuyerProfile() : testProfile(),
    paths: pathsFor(name),
    models,
    model,
    vault: options.vault ?? new PrivateVault(new EnvKeyProvider(TEST_KEY)),
  });
}

describe("main conversation and session persistence", () => {
  it("answers free text, persists the session 0600, and restores after reopen", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const paths = pathsFor("agent");
    const kernel = await openKernel("agent");
    const reply = await kernel.handleUserText("你好，介绍你自己");
    expect(reply.text).toContain("fake 模型");
    expect(reply.quit).toBe(false);
    await kernel.close();

    // File layout and permissions (design §8: dir 0700, files 0600).
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.db).mode & 0o777).toBe(0o600);
    expect(statSync(paths.mainSession).mode & 0o777).toBe(0o600);
    const log = readFileSync(paths.mainSession, "utf8");
    expect(log).toContain("你好，介绍你自己");

    // Reopen: the same session continues (no empty restart).
    const reopened = await openKernel("agent");
    const second = await reopened.handleUserText("还记得我吗");
    expect(second.text.length).toBeGreaterThan(0);
    await reopened.close();
  });

  it("never persists raw thinking content to the session log", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const paths = pathsFor("agent");
    const kernel = await openKernel("agent", {
      steps: [
        fauxAssistantMessage([
          fauxThinking("SECRET-CHAIN-OF-THOUGHT-123"),
          { type: "text", text: "公开回复。" },
        ]),
      ],
    });
    await kernel.handleUserText("想一想");
    await kernel.close();
    const log = readFileSync(paths.mainSession, "utf8");
    expect(log).not.toContain("SECRET-CHAIN-OF-THOUGHT-123");
    expect(log).toContain("公开回复。");
  });

  it("fails closed on a corrupted session log", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const paths = pathsFor("agent");
    writeFileSync(paths.mainSession, "not json at all\n{broken\n");
    await expect(openKernel("agent")).rejects.toThrow(AgentSessionError);
  });

  it("model 变更 → 会话重置（新模型不读旧模型消息）；同模型重开保留", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const paths = pathsFor("agent");
    const { models, model } = createFakeChatModels();
    const kernel = await AgentKernel.open({
      profile: testProfile(),
      paths,
      models,
      model,
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
    });
    await kernel.handleUserText("你好，介绍你自己");
    await kernel.close();
    const firstLog = readFileSync(paths.mainSession, "utf8");
    expect(firstLog).toContain("「你好，介绍你自己」"); // 旧模型回复已持久化

    // 不同 model（同 provider 不同 modelId）→ 打开即重置（旧消息不进入新会话）。
    const otherHandle = fauxProvider({ models: [{ id: "other-chat-model", name: "other-chat-model" }] });
    otherHandle.setResponses([
      fauxAssistantMessage("换模型后的回复"),
      fauxAssistantMessage("换模型后的回复 2"),
      fauxAssistantMessage("换模型后的回复 3"),
      fauxAssistantMessage("换模型后的回复 4"),
      fauxAssistantMessage("换模型后的回复 5"),
    ]);
    const otherModels = createModels();
    otherModels.setProvider(otherHandle.provider);
    const kernel2 = await AgentKernel.open({
      profile: testProfile(),
      paths,
      models: otherModels,
      model: otherHandle.getModel(),
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
    });
    await kernel2.close();
    // close 时 harness 会重写会话文件，但重置后的新会话不含旧模型消息。
    expect(readFileSync(paths.mainSession, "utf8")).not.toContain("「你好，介绍你自己」");

    // 新模型继续对话 → 消息属于新会话。
    const kernel2b = await AgentKernel.open({
      profile: testProfile(),
      paths,
      models: otherModels,
      model: otherHandle.getModel(),
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
    });
    await kernel2b.handleUserText("再次你好");
    await kernel2b.close();
    expect(readFileSync(paths.mainSession, "utf8")).toContain("再次你好");

    // 同模型重开 → 会话保留（重置不是每次打开都发生；也不清掉新模型的消息）。
    const kernel3 = await AgentKernel.open({
      profile: testProfile(),
      paths,
      models: otherModels,
      model: otherHandle.getModel(),
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
    });
    await kernel3.close();
    const finalLog = readFileSync(paths.mainSession, "utf8");
    expect(finalLog).toContain("再次你好");
    expect(finalLog).not.toContain("「你好，介绍你自己」");
  });
});

describe("memory closed loop through the model tool path", () => {
  it("记住 X -> remember tool -> active memory; a later turn retrieves it; /why explains", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await openKernel("agent");
    const reply = await kernel.handleUserText("记住我更喜欢京东自营");
    expect(reply.text).toContain("已记住");

    const memories = kernel.memoryStore.listMemories({});
    expect(memories).toHaveLength(1);
    expect(memories[0]?.status).toBe("active");
    expect(memories[0]?.confidence).toBe(1.0);
    expect(memories[0]?.value).toMatchObject({ note: "我更喜欢京东自营" });

    // A later free-text turn retrieves the memory (logged for /why).
    await kernel.handleUserText("我想买个电饭煲");
    const why = await kernel.handleUserText("/why");
    expect(why.text).toContain(memories[0]?.memory_id);
    expect(why.text).toContain("clarify");
    await kernel.close();
  });

  it("Restricted tool writes fail closed without a data key (no plaintext anywhere)", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await openKernel("agent", {
      vault: new PrivateVault(new EnvKeyProvider(undefined)),
      steps: [
        fauxAssistantMessage([
          fauxToolCall("remember", {
            namespace: "profile",
            key: "contact.address.home",
            restricted_kind: "address",
            restricted_value: "北京市海淀区xx路1号",
            sensitivity: "restricted",
            source_kind: "explicit",
            explicit_user_statement: true,
            reason_summary: "用户提供家庭地址",
          }),
        ]),
        fauxAssistantMessage("（模型继续回复）"),
      ],
    });
    const reply = await kernel.handleUserText("我家住北京市海淀区xx路1号，记住");
    expect(reply.text.length).toBeGreaterThan(0);
    expect(kernel.memoryStore.listMemories({})).toHaveLength(0);
    expect(kernel.memoryStore.vaultEntries()).toHaveLength(0);
    await kernel.close();
    const paths = pathsFor("agent");
    expect(readFileSync(paths.mainSession, "utf8")).toContain("fail closed");
  });

  it("serializes concurrent messages: one model run at a time, in order", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const order: string[] = [];
    let inFlight = 0;
    const slowStep = (text: string) => async () => {
      inFlight += 1;
      order.push(`start:${text}`);
      expect(inFlight).toBe(1);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      order.push(`end:${text}`);
      return fauxAssistantMessage(`回答:${text}`);
    };
    const kernel = await openKernel("agent", { steps: [slowStep("一"), slowStep("二")] });
    const [r1, r2] = await Promise.all([
      kernel.handleUserText("第一条"),
      kernel.handleUserText("第二条"),
    ]);
    expect(r1.text).toBe("回答:一");
    expect(r2.text).toBe("回答:二");
    expect(order).toEqual(["start:一", "end:一", "start:二", "end:二"]);
    await kernel.close();
  });
});

describe("slash commands", () => {
  it("/memory, /correct and /forget govern memories deterministically", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await openKernel("agent");
    await kernel.handleUserText("记住我更喜欢京东自营");
    const id = kernel.memoryStore.listMemories({})[0]?.memory_id as string;

    const overview = await kernel.handleUserText("/memory");
    expect(overview.text).toContain(id);
    expect(overview.text).toContain("[active]");

    const corrected = await kernel.handleUserText(`/correct ${id} {"note":"我更喜欢天猫旗舰"}`);
    expect(corrected.text).toContain("已修正");
    expect(kernel.memoryStore.getMemory(id)?.value).toEqual({ note: "我更喜欢天猫旗舰" });
    expect(kernel.memoryStore.getMemory(id)?.version).toBe(2);

    const forgotten = await kernel.handleUserText(`/forget ${id}`);
    expect(forgotten.text).toContain("已遗忘");
    expect(kernel.memoryStore.listMemories({})).toHaveLength(0);
    expect(kernel.memoryStore.getMemory(id)?.status).toBe("deleted");
    await kernel.close();
  });

  it("/memory private lists fields and status only — never plaintext", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await openKernel("agent");
    kernel.memoryStore.remember({
      namespace: "profile",
      key: "contact.address.home",
      restricted: { kind: "address", plaintext: "北京市海淀区xx路1号" },
      sensitivity: "restricted",
      source_kind: "explicit",
      explicit_user_statement: true,
      evidence: { source_type: "chat", source_ref: "test", summary: "用户提供地址" },
      actor: "user",
    });
    const reply = await kernel.handleUserText("/memory private");
    expect(reply.text).toContain("contact.address.home");
    expect(reply.text).not.toContain("北京市海淀区");
    await kernel.close();
  });

  it("/confirm promotes a constraint candidate (human-only) to active", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await openKernel("agent");
    const outcome = kernel.memoryStore.remember({
      namespace: "constraint",
      key: "shopping.budget.max",
      value: { max: 500 },
      sensitivity: "normal",
      source_kind: "explicit",
      explicit_user_statement: true,
      evidence: { source_type: "chat", source_ref: "test", summary: "用户设定预算上限" },
      actor: "model",
    });
    expect(outcome.kind).toBe("candidate");
    const id = outcome.kind === "candidate" ? outcome.memory.memory_id : "";
    expect((await kernel.handleUserText("/memory")).text).toContain("待确认");
    const confirmed = await kernel.handleUserText(`/confirm ${id}`);
    expect(confirmed.text).toContain("已确认");
    expect(kernel.memoryStore.getMemory(id)?.status).toBe("active");
    await kernel.close();
  });
});

describe("buyer capability pack (v0.3.0-B)", () => {
  it("chat -> create_buyer_task -> search cycle -> shortlist awaiting the user", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await AgentKernel.open({
      profile: testBuyerProfile(),
      paths: pathsFor("buyer"),
      ...scriptedChatModels([
        fauxAssistantMessage([
          fauxToolCall("create_buyer_task", {
            goal_text: "买 2 个陶瓷杯",
            intent: { query_text: "陶瓷杯", category: "kitchenware" },
            constraints: { max_total_price: 200 },
          }),
        ]),
        fauxAssistantMessage("搜索完成，有 1 个候选等你选择。"),
      ]),
      connector: new FakeCommerceConnector([fakeConnectorProduct()]),
      vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
    });
    const reply = await kernel.handleUserText("我想买 2 个陶瓷杯，预算 200");
    expect(reply.text).toContain("候选");

    const tasks = kernel.buyerTasks?.listTasks() ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("awaiting_user");
    const candidates = kernel.buyerTasks?.listCandidates(tasks[0]?.task_id ?? "") ?? [];
    expect(candidates[0]?.candidate_status).toBe("shortlisted");
    expect(candidates[0]?.score_explanation?.dimensions.length).toBeGreaterThan(0);
    await kernel.close();
  });

  it("kernel injects KiwiCatalogSource when catalog is configured (CD #27 wiring)", async () => {
    // 回归：search_listings 工具曾只在测试里注入、kernel 运行时从未挂载
    // （dead code）。这里用请求记录 server 证明：kernel 配置 catalog 后，
    // 模型调用 search_listings 真实打到了 kiwi-catalog 面。
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const http = await import("node:http");
    const hits: string[] = [];
    const server = http.createServer((_req, res) => {
      hits.push(_req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, results: [], next_cursor: "" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const kernel = await AgentKernel.open({
        profile: testBuyerProfile(),
        paths: pathsFor("buyer-catalog"),
        ...scriptedChatModels([
          fauxAssistantMessage([
            fauxToolCall("search_listings", { need_description: "Test", limit: 5 }),
          ]),
          fauxAssistantMessage("搜索完成。"),
        ]),
        connector: new FakeCommerceConnector([fakeConnectorProduct()]),
        catalog: `http://127.0.0.1:${port}`,
        vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
      });
      const reply = await kernel.handleUserText("搜索一下 Test 商品");
      expect(reply.text).toContain("搜索完成");
      await kernel.close();
      expect(hits.some((url) => url.includes("/v1/listings/search"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("physical isolation (design §17)", () => {
  it("buyer and merchant kernels have separate stores; role mismatch fails closed", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const buyerKernel = await openKernel("buyer", { buyer: true });
    await buyerKernel.handleUserText("记住我更喜欢京东自营");
    expect(buyerKernel.memoryStore.listMemories({})).toHaveLength(1);
    await buyerKernel.close();

    // The merchant agent's own directory knows nothing about the buyer.
    const merchantKernel = await openKernel("merchant");
    expect(merchantKernel.memoryStore.listMemories({})).toHaveLength(0);

    // Binding a merchant profile to the buyer's directory fails closed.
    await expect(
      AgentKernel.open({
        profile: testProfile(),
        paths: pathsFor("buyer"),
        ...createFakeChatModels(),
      }),
    ).rejects.toThrow(/immutable|isolation/i);
    await merchantKernel.close();
  });
});

describe("sensitive routing and model failure resilience", () => {
  it("a remembered address is routed to the Vault, never plaintext", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await openKernel("agent");
    await kernel.handleUserText("记住我家住在北京市海淀区xx路1号");
    const memories = kernel.memoryStore.listMemories({});
    expect(memories).toHaveLength(1);
    expect(memories[0]?.sensitivity).toBe("restricted");
    expect(memories[0]?.status).toBe("candidate"); // human /confirm required
    expect(memories[0]?.value).toBeUndefined();
    expect(memories[0]?.vault_ref).toMatch(/^vr_/);
    await kernel.close();
  });

  it("/approve and /reject accept a unique candidate-id prefix", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await openKernel("agent");
    const approvals = kernel.actionCandidates;
    expect(approvals).toBeDefined();
    approvals!.create({
      tool: "test_write",
      arguments: { a: 1 },
      preconditions: {},
      risk: "test",
      expires_at: "2099-01-01T00:00:00Z",
    });
    const full = approvals!.listPending()[0]?.candidate_id as string;
    const prefix = full.slice(0, 12);
    // The prefix resolves to the FULL id (the reply names it, not "未知候选").
    const approve = await kernel.handleUserText(`/approve ${prefix}`);
    expect(approve.text).toContain(full);
    expect(approve.text).not.toContain("未知审批候选");

    // A second candidate exercises the same prefix resolution on /reject.
    approvals!.create({
      tool: "test_write2",
      arguments: { b: 2 },
      preconditions: {},
      risk: "test",
      expires_at: "2099-01-01T00:00:00Z",
    });
    const full2 = approvals!.listPending()[0]?.candidate_id as string;
    const reject = await kernel.handleUserText(`/reject ${full2.slice(0, 12)}`);
    expect(reject.text).toContain("已驳回");
    expect(reject.text).toContain(full2);
    await kernel.close();
  });

  it("/approve accepts /pending indices and 'all'", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await openKernel("agent");
    const approvals = kernel.actionCandidates;
    expect(approvals).toBeDefined();
    approvals!.create({ tool: "w1", arguments: {}, preconditions: {}, risk: "t", expires_at: "2099-01-01T00:00:00Z" });
    approvals!.create({ tool: "w2", arguments: {}, preconditions: {}, risk: "t", expires_at: "2099-01-01T00:00:00Z" });

    // /pending renders numbered entries.
    const list = await kernel.handleUserText("/pending");
    expect(list.text).toMatch(/1\. act_/);
    expect(list.text).toMatch(/2\. act_/);

    // Index 1 -> the first pending candidate; the reply names its full id.
    const first = approvals!.listPending()[0]?.candidate_id as string;
    const approve = await kernel.handleUserText("/approve 1");
    expect(approve.text).toContain(first);
    expect(approve.text).not.toContain("未知审批候选");

    // 'all' processes whatever remains.
    const all = await kernel.handleUserText("/approve all");
    expect(all.text).toContain("已处理 1 个候选");
    await kernel.close();
  });

  it("/approve 拒绝进制/科学计数法序号（评审项：Number('0x10')=16 会误批非预期候选）", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await openKernel("agent");
    const approvals = kernel.actionCandidates;
    expect(approvals).toBeDefined();
    const firstId = approvals!.create({ tool: "w1", arguments: {}, preconditions: {}, risk: "t", expires_at: "2099-01-01T00:00:00Z" }).candidate_id;

    // 修复前 Number("0x10")=16 会解析成序号（pending 足够多时）或前缀匹配失败；
    // 修复后非纯十进制一律不按序号解析，退回前缀/精确匹配 → 无匹配 → 拒绝。
    const hex = await kernel.handleUserText("/approve 0x1");
    expect(hex.text).toContain("未知审批候选");
    const sci = await kernel.handleUserText("/approve 1e0");
    expect(sci.text).toContain("未知审批候选");
    // 十进制序号仍正常工作
    const dec = await kernel.handleUserText("/approve 1");
    expect(dec.text).toContain(firstId);
    await kernel.close();
  });

  it("/private reveals the owner's own Restricted (Vault) values", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const kernel = await openKernel("agent"); // merchant, keyed vault
    kernel.memoryStore.remember({
      namespace: "profile",
      key: "merchant.floor_price.sku-001",
      restricted: { kind: "merchant_floor", plaintext: "floor-73.5" },
      sensitivity: "restricted",
      source_kind: "explicit",
      explicit_user_statement: true,
      evidence: { source_type: "chat", source_ref: "test", summary: "底价" },
      actor: "user",
    });
    const reply = await kernel.handleUserText("/private");
    expect(reply.text).toContain("floor-73.5");
    await kernel.close();
  });

  it("a model failure in one turn does not kill the session", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-agent-"));
    const boom = (): never => {
      throw new Error("provider boom");
    };
    const kernel = await openKernel("agent", {
      steps: [boom, boom, boom, boom] as FauxResponseStep[],
    });
    const reply = await kernel.handleUserText("你好");
    // Either the harness threw (caught) or returned empty — the turn must
    // surface a non-empty reply, never crash the session.
    expect(reply.text.length).toBeGreaterThan(0);
    const help = await kernel.handleUserText("/help");
    expect(help.text).toContain("/memory");
    await kernel.close();
  });
});
