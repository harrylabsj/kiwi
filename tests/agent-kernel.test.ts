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
