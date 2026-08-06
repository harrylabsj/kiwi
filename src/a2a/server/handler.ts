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
