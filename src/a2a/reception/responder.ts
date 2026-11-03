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

const FALLBACK_TEXT =
  "抱歉，当前无法处理这条消息，请稍后重试，或直接发送 RFQ（SKU、数量、单位）。";

/** 从 1.0 wire parts 中取出文本（兼容 {text} 与 {kind:"text",text}）。 */
export function textPartsOf(message: Record<string, unknown>): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
    const obj = part as Record<string, unknown>;
    if (typeof obj.text === "string") texts.push(obj.text);
    else if (obj.kind === "text" && typeof obj.text === "string") texts.push(obj.text);
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

export function createReceptionResponder(
  engine: ReceptionEngine,
  merchantId: string,
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
      });
      return agentMessage(result.text);
    } catch {
      return agentMessage(FALLBACK_TEXT);
    }
  };
}
