/**
 * 把接待引擎适配为 A2A generic responder。
 *
 * 只处理普通 A2A 文本；KNP envelope 仍走磋商管线。响应必须是 1.0 wire
 * 形状（ROLE_AGENT + 统一 text Part）。任何引擎异常都返回确定性的中文
 * 兜底文案，绝不回显原文或泄露内部错误。
 */

import { uuidv7 } from "../../negotiation/domain/identifiers.js";
import type {
  GenericMessageResponder,
  GenericMessageResponse,
  GenericResponderInput,
} from "../server/generic-responder.js";
import type { ReceptionEngine } from "./engine.js";
import { StreamGateError } from "../../merchant-core/customer-delivery/stream-gate.js";
import { rateLimited } from "../server/errors.js";

const FALLBACK_TEXT =
  "抱歉，当前无法处理这条消息，请稍后重试，或直接发送 RFQ（SKU、数量、单位）。";

/** 从 1.0 wire parts 中取出文本（兼容 {text} 与 {kind:"text",text}）。 */
export function textPartsOf(message: Record<string, unknown>): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
    const obj = part as Record<string, unknown>;
    // 1.0 wire 的 `{text}` 与 `{kind:"text",text}` 都以 text 字段承载；
    // 第一个分支已覆盖两种形状，保留单一判断避免不可达的重复分支。
    if (typeof obj.text === "string") texts.push(obj.text);
  }
  return texts.join("\n").trim();
}

function agentMessage(text: string): GenericMessageResponse {
  return {
    message: {
      role: "ROLE_AGENT",
      parts: [{ text }],
      messageId: `msg_${uuidv7()}`,
    },
  };
}

/** 普通文本路径的验签询价钩子（K1 自动建档；由 A2A 节点装配注入）。 */
export interface ReceptionResponderHooks {
  onVerifiedInquiry?(input: { identity: string; contextId: string; messageId?: string }): void;
  historyNote?(input: { identity: string; text: string }): string;
}

export function createReceptionResponder(
  engine: ReceptionEngine,
  merchantId: string,
  hooks?: ReceptionResponderHooks,
): GenericMessageResponder {
  return async (input: GenericResponderInput): Promise<GenericMessageResponse> => {
    const text = textPartsOf(input.message);
    try {
      const result = await engine.respond({
        merchantId,
        identity: input.identity ?? "anonymous",
        identityVerified: input.identityVerified === true,
        contextId: input.contextId,
        text,
        now: input.now(),
        ...(typeof input.message.messageId === "string"
          ? { messageId: input.message.messageId }
          : {}),
      });
      // K1：判定为有效询价且身份已验签时通知业务边界（建档）；
      // 建档失败不影响回复（writer 内部已收敛并可靠重试）。
      if (result.recognizedInquiry && input.identityVerified === true && hooks?.onVerifiedInquiry !== undefined) {
        try {
          hooks.onVerifiedInquiry({
            identity: input.identity as string,
            contextId: input.contextId,
            ...(typeof input.message.messageId === "string"
              ? { messageId: input.message.messageId }
              : {}),
          });
        } catch {
          // 钩子异常不阻断接待回复。
        }
      }
      const history = input.identityVerified === true && input.identity !== undefined
        ? hooks?.historyNote?.({ identity: input.identity, text }) ?? ""
        : "";
      return agentMessage(result.text + history);
    } catch (error) {
      if (error instanceof StreamGateError) throw rateLimited(2, "reception_stream_busy");
      return agentMessage(FALLBACK_TEXT);
    }
  };
}
