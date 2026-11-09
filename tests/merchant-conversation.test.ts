/**
 * 商家多轮会话 MCP 适配（离线）：
 *   - 复用同一 kernel 的多轮 conversation_id；
 *   - 会话按 principal + merchant 绑定，跨主体/跨商家不可续接；
 *   - 未装配 conversation 时不暴露对话工具；
 *   - 不新建智能体、不接受实例 URL。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MerchantAuthorization } from "../src/auth/merchant-authorization.js";
import {
  MERCHANT_CHAT_TOOL,
  MerchantConversationManager,
  type MerchantConversationKernelFactoryInput,
} from "../src/mcp/merchant-conversation.js";
import { buildMerchantMcpTools } from "../src/mcp/merchant-tools.js";
import type { MerchantWorkbenchSurface } from "../src/merchant/workbench-service.js";

const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";
const AUTH: MerchantAuthorization = {
  principal_id: PRINCIPAL,
  merchant_id: MERCHANT,
  scopes: ["merchant:read"],
};

interface FakeKernel {
  handleUserText(text: string): Promise<{ text: string; quit: boolean }>;
  listPendingApprovals(): Array<{
    candidate_id: string;
    tool: string;
    risk: string;
    status: string;
    expires_at: string;
  }>;
  close(): Promise<void>;
  texts: string[];
  closed: boolean;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function managerWithFake(
  overrides: { maxSessions?: number; now?: () => number; merchantDataDir?: string } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "kiwi-conversation-"));
  dirs.push(root);
  const merchantDataDir =
    overrides.merchantDataDir ?? mkdtempSync(path.join(tmpdir(), "kiwi-merchant-data-"));
  if (overrides.merchantDataDir === undefined) dirs.push(merchantDataDir);
  const kernels: FakeKernel[] = [];
  const inputs: MerchantConversationKernelFactoryInput[] = [];
  const manager = new MerchantConversationManager({
    profile: { owner_id: MERCHANT } as never,
    dataRoot: root,
    merchantDataDir,
    ...(overrides.maxSessions !== undefined ? { maxSessions: overrides.maxSessions } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    createKernel: async (input) => {
      inputs.push(input);
      const texts: string[] = [];
      const kernel: FakeKernel = {
        texts,
        closed: false,
        async handleUserText(text) {
          texts.push(text);
          return { text: `echo:${text}`, quit: false };
        },
        listPendingApprovals: () => [],
        async close() {
          kernel.closed = true;
        },
      };
      kernels.push(kernel);
      return kernel;
    },
  });
  return { manager, kernels, inputs };
}

describe("MerchantConversationManager", () => {
  it("缺 merchantDataDir 构造即 fail-closed（不静默回退会话目录）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-conversation-missing-"));
    dirs.push(root);
    expect(
      () =>
        new MerchantConversationManager({
          profile: { owner_id: MERCHANT } as never,
          dataRoot: root,
        } as never),
    ).toThrow(/merchantDataDir/);
  });

  it("同一 conversation_id 复用同一 kernel；新会话创建新 kernel", async () => {
    const { manager, kernels } = managerWithFake();
    const first = await manager.chat(AUTH, { message: "你好" });
    expect(first.conversation_id).toMatch(/^conv_/);
    expect(first.reply).toBe("echo:你好");
    const second = await manager.chat(AUTH, {
      message: "继续",
      conversation_id: first.conversation_id,
    });
    expect(second.conversation_id).toBe(first.conversation_id);
    expect(kernels).toHaveLength(1);
    expect(kernels[0]?.texts).toEqual(["你好", "继续"]);

    const other = await manager.chat(AUTH, { message: "新会话" });
    expect(other.conversation_id).not.toBe(first.conversation_id);
    expect(kernels).toHaveLength(2);
    await manager.close();
    expect(kernels.every((kernel) => kernel.closed)).toBe(true);
  });

  it("跨主体/跨商家/缺 scope 不可续接，且不泄露会话存在性", async () => {
    const { manager } = managerWithFake();
    const created = await manager.chat(AUTH, { message: "起点" });

    await expect(
      manager.chat(
        { ...AUTH, principal_id: "merchant-agent:other" },
        { message: "越权", conversation_id: created.conversation_id },
      ),
    ).rejects.toMatchObject({ kind: "not_found" });

    await expect(
      manager.chat(
        { ...AUTH, merchant_id: "merchant-002" },
        { message: "越权", conversation_id: created.conversation_id },
      ),
    ).rejects.toMatchObject({ kind: "auth" });

    await expect(
      manager.chat(
        { ...AUTH, scopes: ["merchant:write"] },
        { message: "缺 read" },
      ),
    ).rejects.toMatchObject({ kind: "auth" });

    await expect(
      manager.chat(undefined, { message: "未认证" }),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("会话数量上限与消息校验", async () => {
    const { manager } = managerWithFake({ maxSessions: 1 });
    await manager.chat(AUTH, { message: "第一" });
    await expect(manager.chat(AUTH, { message: "第二" })).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(manager.chat(AUTH, { message: "   " })).rejects.toMatchObject({
      kind: "validation",
    });
    await expect(manager.chat(AUTH, { message: "/mode autopilot" })).rejects.toMatchObject({
      kind: "validation",
    });
  });

  it("同一会话并发 turn 串行执行，不同 turn 不交叉", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-conversation-serial-"));
    dirs.push(root);
    let active = 0;
    let maxActive = 0;
    const manager = new MerchantConversationManager({
      profile: { owner_id: MERCHANT } as never,
      dataRoot: root,
      merchantDataDir: root,
      createKernel: async () => ({
        async handleUserText(text) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return { text: `echo:${text}`, quit: false };
        },
        listPendingApprovals: () => [],
        async close() {},
      }),
    });
    const first = await manager.chat(AUTH, { message: "start" });
    await Promise.all([
      manager.chat(AUTH, { message: "a", conversation_id: first.conversation_id }),
      manager.chat(AUTH, { message: "b", conversation_id: first.conversation_id }),
    ]);
    expect(maxActive).toBe(1);
    await manager.close();
  });

  it("内核原始异常不会透出路径/URL/token 文案", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-conversation-errors-"));
    dirs.push(root);
    const manager = new MerchantConversationManager({
      profile: { owner_id: MERCHANT } as never,
      dataRoot: root,
      merchantDataDir: root,
      createKernel: async () => ({
        async handleUserText() {
          throw new Error("secret /tmp/private token=abc");
        },
        listPendingApprovals: () => [],
        async close() {},
      }),
    });
    await expect(manager.chat(AUTH, { message: "读取" })).rejects.toMatchObject({
      kind: "unavailable",
      message: "商家对话执行失败，请稍后重试",
    });
    await manager.close();
  });

  it("装配只读限制：会话状态目录与实例业务数据目录分离，并强制只读白名单", async () => {
    const merchantDataDir = mkdtempSync(path.join(tmpdir(), "kiwi-merchant-data-"));
    dirs.push(merchantDataDir);
    const { manager, inputs } = managerWithFake({ merchantDataDir });
    await manager.chat(AUTH, { message: "读取我的数据" });
    expect(inputs[0]?.merchantDataRoot).toBe(merchantDataDir);
    expect(inputs[0]?.readOnlyMerchantTools).toBe(true);
    expect(inputs[0]?.dataDir.startsWith(merchantDataDir)).toBe(false);
  });
});

describe("MCP 对话工具", () => {
  const service = {} as unknown as MerchantWorkbenchSurface;

  it("未装配 conversation 时工具不出现；装配后仅按 OAuth 主体调用", async () => {
    const without = buildMerchantMcpTools(service);
    expect(without.tools.some((tool) => tool.name === MERCHANT_CHAT_TOOL)).toBe(false);

    const { manager } = managerWithFake();
    const withChat = buildMerchantMcpTools(service, { conversation: manager });
    const definition = withChat.tools.find((tool) => tool.name === MERCHANT_CHAT_TOOL);
    expect(definition).toBeDefined();
    expect(definition?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["message"],
    });

    const result = await withChat.call(
      MERCHANT_CHAT_TOOL,
      { message: "对话" },
      ["merchant:read"],
      AUTH,
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      reply: "echo:对话",
      quit: false,
      pending_actions: [],
    });
    const conversationId = (result.structuredContent as { conversation_id: string })
      .conversation_id;
    expect(conversationId).toMatch(/^conv_/);

    const anonymous = await withChat.call(
      MERCHANT_CHAT_TOOL,
      { message: "无主体" },
      ["merchant:read"],
    );
    expect(anonymous.isError).toBe(true);
    expect(anonymous.content[0]?.text).toContain("OAuth 主体");
  });
});
