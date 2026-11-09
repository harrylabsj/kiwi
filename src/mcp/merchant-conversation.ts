/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 商家与同一云端 Kiwi 商家智能体的多轮会话（MCP 适配层）。
 *
 * 复用既有 `buildChatKernel`（`kiwi chat` / merchant HTTP adapter 同一内核），
 * 不新建智能体；本模块只做：
 *   - 按 (merchant_id, principal_id, conversation_id) 绑定并复用同一 kernel；
 *   - 强制 merchant 归属与 `merchant:read` scope；
 *   - 会话数据目录由服务端从已绑定身份派生，**不接受模型指定的实例 URL**；
 *   - 返回稳定 conversation_id 供后续轮次续接。
 *
 * 写操作仍由内核既有审批/权限边界处理；本模块不提供“已批准/已执行”的捷径。
 */

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { buildChatKernel } from "../agent/kernel-builder.js";
import type { AgentEventSink } from "../agent/host/events.js";
import type { KernelReply } from "../agent/kernel.js";
import type { AgentProfile } from "../config/profile.js";
import type { MerchantAuthorization } from "../auth/merchant-authorization.js";
import { MERCHANT_READ_SCOPE } from "../auth/merchant-scopes.js";
import { MerchantWorkbenchError } from "../merchant/workbench-service.js";

export const MERCHANT_CHAT_TOOL = "kiwi_merchant_chat";
const MAX_MESSAGE_CHARS = 20_000;
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

export interface MerchantConversationKernel {
  handleUserText(text: string): Promise<KernelReply>;
  listPendingApprovals?(): Array<{
    candidate_id: string;
    tool: string;
    risk: string;
    status: string;
    expires_at: string;
  }>;
  close(): Promise<void>;
}

export interface MerchantConversationKernelFactoryInput {
  profile: AgentProfile;
  dataDir: string;
  /** 商家实例权威业务数据根目录（a2a ledger / intelligence），与 session dataDir 分离。 */
  merchantDataRoot: string;
  /** 强制只读商家工具；由 manager 固定为 true。 */
  readOnlyMerchantTools: true;
  eventSink: AgentEventSink;
  eventSessionId: string;
}

export interface MerchantConversationManagerOptions {
  profile: AgentProfile;
  /** 每会话本地状态根目录（agent state/session），不是业务事实目录。 */
  dataRoot: string;
  /** 商家实例权威业务事实目录（a2a ledger / intelligence）；必填，缺失 fail-closed。 */
  merchantDataDir: string;
  catalog?: string;
  createKernel?: (
    input: MerchantConversationKernelFactoryInput,
  ) => Promise<MerchantConversationKernel>;
  maxSessions?: number;
  idleTtlMs?: number;
  now?: () => number;
}

export interface MerchantChatInput {
  message: unknown;
  conversation_id?: unknown;
}

export interface MerchantChatResult {
  conversation_id: string;
  reply: string;
  quit: boolean;
  pending_actions: Array<{
    candidate_id: string;
    tool: string;
    risk: string;
    status: string;
    expires_at: string;
  }>;
}

interface ConversationRecord {
  conversationId: string;
  principalId: string;
  merchantId: string;
  kernel: MerchantConversationKernel;
  lastAccessAt: number;
  /** 同一 conversation 的 turn 串行化；不同会话互不阻塞。 */
  inflight: Promise<void>;
}

function keyFor(merchantId: string, principalId: string, conversationId: string): string {
  return `${merchantId}\u0000${principalId}\u0000${conversationId}`;
}

function dataDirFor(root: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return path.join(root, digest);
}

/** 同一实例、同一认证主体的多轮会话管理器。 */
export class MerchantConversationManager {
  private readonly profile: AgentProfile;
  private readonly dataRoot: string;
  private readonly merchantDataDir: string;
  private readonly catalog: string | undefined;
  private readonly createKernel: (
    input: MerchantConversationKernelFactoryInput,
  ) => Promise<MerchantConversationKernel>;
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, ConversationRecord>();

  constructor(options: MerchantConversationManagerOptions) {
    this.profile = options.profile;
    this.dataRoot = options.dataRoot;
    if (typeof options.merchantDataDir !== "string" || options.merchantDataDir.trim() === "") {
      throw new Error("MerchantConversationManager requires merchantDataDir");
    }
    this.merchantDataDir = options.merchantDataDir;
    this.catalog = options.catalog;
    this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.idleTtlMs = Math.max(1_000, options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
    this.now = options.now ?? Date.now;
    this.createKernel =
      options.createKernel ??
      (async (input) =>
        buildChatKernel(
          input.profile,
          input.dataDir,
          this.catalog,
          input.eventSink,
          input.eventSessionId,
          undefined,
          {
            merchantDataRoot: input.merchantDataRoot,
            readOnlyMerchantTools: true,
          },
        ));
  }

  async chat(
    authorization: MerchantAuthorization | undefined,
    input: MerchantChatInput,
  ): Promise<MerchantChatResult> {
    this.assertIdentity(authorization);
    const identity = authorization as MerchantAuthorization;
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (message === "") {
      throw new MerchantWorkbenchError("validation", "message 不能为空");
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      throw new MerchantWorkbenchError("validation", `message 不能超过 ${MAX_MESSAGE_CHARS} 字符`);
    }
    if (message.startsWith("/")) {
      throw new MerchantWorkbenchError("validation", "只读对话不接受斜杠命令或模式切换");
    }
    const requestedId =
      typeof input.conversation_id === "string" ? input.conversation_id.trim() : "";
    await this.sweepExpired();

    let record: ConversationRecord;
    if (requestedId === "") {
      if (this.sessions.size >= this.maxSessions) {
        throw new MerchantWorkbenchError("unavailable", "商家会话数量已达上限，请结束旧会话后重试");
      }
      const conversationId = `conv_${randomUUID()}`;
      const key = keyFor(identity.merchant_id, identity.principal_id, conversationId);
      const eventSessionId = `mcp-chat-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
      const eventSink: AgentEventSink = { emit: () => undefined };
      let kernel: MerchantConversationKernel;
      try {
        kernel = await this.createKernel({
          profile: this.profile,
          dataDir: dataDirFor(this.dataRoot, key),
          merchantDataRoot: this.merchantDataDir,
          readOnlyMerchantTools: true,
          eventSink,
          eventSessionId,
        });
      } catch {
        throw new MerchantWorkbenchError("unavailable", "商家对话内核不可用，请稍后重试");
      }
      record = {
        conversationId,
        principalId: identity.principal_id,
        merchantId: identity.merchant_id,
        kernel,
        lastAccessAt: this.now(),
        inflight: Promise.resolve(),
      };
      this.sessions.set(key, record);
    } else {
      const key = keyFor(identity.merchant_id, identity.principal_id, requestedId);
      const existing = this.sessions.get(key);
      if (existing === undefined) {
        // 不泄露其他主体/其他实例是否存在该会话。
        throw new MerchantWorkbenchError("not_found", "未找到该会话，请重新开始对话");
      }
      record = existing;
      record.lastAccessAt = this.now();
    }

    try {
      // 同一 conversation 串行执行；并发 turn 不共享内核中间状态。
      const run = record.inflight.then(() => record.kernel.handleUserText(message));
      record.inflight = run.then(
        () => undefined,
        () => undefined,
      );
      const reply = await run;
      const pending = record.kernel.listPendingApprovals?.() ?? [];
      return {
        conversation_id: record.conversationId,
        reply: reply.text,
        quit: reply.quit,
        pending_actions: pending.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          tool: candidate.tool,
          risk: candidate.risk,
          status: candidate.status,
          expires_at: candidate.expires_at,
        })),
      };
    } catch (err) {
      // 不向客户端/日志透出内核原始异常（可能含路径、URL 或上游细节），
      // 即使内核抛的是带具体 message 的 MerchantWorkbenchError 也统一收敛。
      void err;
      throw new MerchantWorkbenchError("unavailable", "商家对话执行失败，请稍后重试");
    }
  }

  async close(): Promise<void> {
    const records = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(records.map((record) => record.kernel.close()));
  }

  private assertIdentity(authorization: MerchantAuthorization | undefined): void {
    if (authorization === undefined) {
      throw new MerchantWorkbenchError("auth", "对话需要已认证的商家 OAuth 主体");
    }
    if (
      authorization.principal_id.trim() === "" ||
      authorization.merchant_id.trim() === ""
    ) {
      throw new MerchantWorkbenchError("auth", "对话缺少商家授权主体");
    }
    if (authorization.merchant_id !== this.profile.owner_id) {
      throw new MerchantWorkbenchError("auth", "当前授权主体不属于本商家实例");
    }
    if (!authorization.scopes.includes(MERCHANT_READ_SCOPE)) {
      throw new MerchantWorkbenchError("auth", `对话需要 ${MERCHANT_READ_SCOPE} scope`);
    }
  }

  private async sweepExpired(): Promise<void> {
    const cutoff = this.now() - this.idleTtlMs;
    const expired: ConversationRecord[] = [];
    for (const [key, record] of this.sessions) {
      if (record.lastAccessAt <= cutoff) {
        this.sessions.delete(key);
        expired.push(record);
      }
    }
    await Promise.allSettled(expired.map((record) => record.kernel.close()));
  }
}

export function buildMerchantChatToolDefinition(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: MERCHANT_CHAT_TOOL,
    description:
      "与当前已授权商家实例中的同一个云端 Kiwi 商家智能体进行**只读**多轮对话（复用商家内核；不新建智能体）。仅注入商家读工具，不执行写操作/外部动作；必须携带有效 OAuth 主体，不接受实例 URL 或 merchant_id。返回 conversation_id 供后续轮次续接。",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "发送给本商家云端智能体的消息" },
        conversation_id: {
          type: "string",
          description: "上一轮返回的 conversation_id；省略则开始新会话",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  };
}
