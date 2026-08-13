#!/usr/bin/env node
/**
 * TCK 参考响应器（issue 10）：按官方 a2a-python 参考 SUT 的 messageId 前缀路由，
 * 供 `start-tck-sut.mjs` 注入 A2AServer.genericResponder。
 *
 * 参考实现：`a2a-tck/sut/a2a-python/sut_agent.py`——TCK 场景由 messageId 前缀
 * 触发（complete-task / input-required / artifact-* / message-response）。
 * 本文件把同样的前缀路由翻译为 kiwi generic-responder 契约（legacy 内部状态名
 * completed / input-required + 1.0 wire Part）。
 *
 * 注意：这是 conformance 层，不进入产品默认路径（产品缺省 = spec 一致回显）。
 */
import { randomUUID } from "node:crypto";

const PART_TEXT = "Generated text content";
const DIRECT_RESPONSE_TEXT = "Direct message response";
const TCK_ECHO_TEXT = "Hello from TCK";

function artifact(parts) {
  return { artifactId: `art_${randomUUID()}`, parts };
}

function textPart(text) {
  return { text };
}

/**
 * 构造 TCK 参考响应器。返回 (input) => GenericMessageResponse。
 * 各前缀行为与官方参考 SUT 一一对应：
 *  - tck-message-response  → 直接返回 Message（非 Task）
 *  - tck-input-required    → Task INPUT_REQUIRED
 *  - tck-complete-task     → Task COMPLETED（回显 "Hello from TCK"）
 *  - tck-artifact-text     → Task COMPLETED + text artifact
 *  - tck-artifact-file     → Task COMPLETED + raw/file artifact
 *  - tck-artifact-file-url → Task COMPLETED + url artifact
 *  - tck-artifact-data     → Task COMPLETED + data artifact
 *  - 其他                  → Task COMPLETED（回显 "Unhandled messageId prefix"）
 */
export function createTckReferenceResponder() {
  return (input) => {
    const message = input.message;
    const messageId = typeof message.messageId === "string" ? message.messageId : "";
    const completed = (extra = {}) => ({
      task: {
        state: "completed",
        contextId: input.contextId,
        statusMessage: {
          role: "ROLE_AGENT",
          parts: [textPart(TCK_ECHO_TEXT)],
          messageId: `msg_${randomUUID()}`,
        },
        ...extra,
      },
    });

    if (messageId.startsWith("tck-message-response")) {
      return {
        message: {
          role: "ROLE_AGENT",
          parts: [textPart(DIRECT_RESPONSE_TEXT)],
          messageId: `msg_${randomUUID()}`,
        },
      };
    }
    if (messageId.startsWith("tck-input-required")) {
      return {
        task: {
          state: "input-required",
          contextId: input.contextId,
          statusMessage: {
            role: "ROLE_AGENT",
            parts: [textPart(TCK_ECHO_TEXT)],
            messageId: `msg_${randomUUID()}`,
          },
        },
      };
    }
    if (messageId.startsWith("tck-artifact-text")) {
      return completed({ artifacts: [artifact([textPart(PART_TEXT)])] });
    }
    // 注意顺序：`tck-artifact-file-url` 是 `tck-artifact-file` 的前缀，必须先判。
    if (messageId.startsWith("tck-artifact-file-url")) {
      return completed({
        artifacts: [
          artifact([
            { url: "https://example.com/output.txt", mediaType: "text/plain", filename: "output.txt" },
          ]),
        ],
      });
    }
    if (messageId.startsWith("tck-artifact-file")) {
      return completed({
        artifacts: [
          artifact([
            { raw: Buffer.from("tck").toString("base64"), mediaType: "text/plain", filename: "output.txt" },
          ]),
        ],
      });
    }
    if (messageId.startsWith("tck-artifact-data")) {
      return completed({
        artifacts: [artifact([{ data: { key: "value", count: 42 } }])],
      });
    }
    if (messageId.startsWith("tck-complete-task")) {
      return completed();
    }
    // 默认：完成任务，回显未处理前缀。
    return {
      task: {
        state: "completed",
        contextId: input.contextId,
        statusMessage: {
          role: "ROLE_AGENT",
          parts: [textPart(`Unhandled messageId prefix: ${messageId}`)],
          messageId: `msg_${randomUUID()}`,
        },
      },
    };
  };
}
