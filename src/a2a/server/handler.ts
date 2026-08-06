/**
 * NegotiationHandler 安全桩（接口定义见 types.ts）。
 *
 * 本 WP 不接线真正的 Negotiation Engine（后续 WP）。这里提供两个安全默认：
 *   - echoHandler     校验通过后原样回显 KNP envelope（ack: true），无任何副作用，
 *                     适合往返测试 / 协议调试。
 *   - declineHandler  一律拒绝（reason_code 默认 "handler_not_configured"）——
 *                     fail-closed 默认（§4.6）：未配置引擎时不产生任何商业承诺。
 *
 * 两个桩都不触发本地工具、不写 Principal Memory（基线 §4.5 / §36-13）。
 */

import { uuidv7 } from "../../negotiation/domain/identifiers.js";
import type {
  InboundNegotiationContext,
  NegotiationHandler,
  NegotiationHandlerResult,
} from "./types.js";

/** 原样回显已校验 envelope 的安全桩。 */
export function echoHandler(): NegotiationHandler {
  return {
    name: "echo",
    async handle(ctx: InboundNegotiationContext): Promise<NegotiationHandlerResult> {
      return {
        kind: "accepted",
        message: {
          role: "agent",
          parts: [{ kind: "data", data: { knp_envelope: ctx.envelope, ack: true } }],
          messageId: `msg_${uuidv7()}`,
        },
      };
    },
  };
}

/** 全部拒绝的安全桩（缺省 handler）。 */
export function declineHandler(reasonCode = "handler_not_configured"): NegotiationHandler {
  return {
    name: "decline",
    async handle(_ctx: InboundNegotiationContext): Promise<NegotiationHandlerResult> {
      return { kind: "declined", reasonCode };
    },
  };
}

/** 未配置 handler 时的 fail-closed 默认。 */
export function defaultHandler(): NegotiationHandler {
  return declineHandler();
}
