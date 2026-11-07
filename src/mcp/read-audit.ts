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
 * 商家私有数据的只读访问审计。
 *
 * 记录"谁在何时通过哪个工具读了哪个对象、结果类别"，不记录正文、金额、
 * 凭据或分享码。写入失败时调用方必须拒绝返回数据（fail-closed），避免
 * 出现无法追溯的私有数据读取。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { MerchantMcpCallResult } from "./merchant-tools.js";

/** 需要审计的只读工具（阶段一：运营报告与洽谈）。 */
export const READ_AUDIT_TOOLS: ReadonlySet<string> = new Set([
  "kiwi_merchant_get_operations_report",
  "kiwi_merchant_get_a2a_negotiation",
  "kiwi_merchant_list_active_consultations",
  "kiwi_merchant_list_a2a_negotiations",
]);

export interface ReadAuditEvent {
  /** 记录时间（注入时钟；ISO 8601）。 */
  at: string;
  /** 调用主体（OAuth principal；静态 token 过渡模式为 static-token）。 */
  principal_id: string;
  /** 实例归属商家（单实例装配固定值）。 */
  merchant_id: string;
  tool: string;
  /** 结果类别：ok / error。 */
  outcome: "ok" | "error";
  /** 稳定错误码（仅 error）。 */
  code?: string;
  /** 被读取对象标识（洽谈 ID；报告周期），不含正文。 */
  object_id?: string;
}

export interface ReadAuditLog {
  record(event: ReadAuditEvent): void;
}

export interface ReadAuditContext {
  log: ReadAuditLog;
  principalId: string;
  merchantId: string;
  now: () => string;
}

/**
 * 追加式 JSONL 审计日志（目录 0700、文件 0600）。
 *
 * 与 `merchant-core` 的私密阈值审计同一目录约定；调用方必须在同一实例
 * 数据目录上创建，避免跨实例混写。
 */
export function createReadAuditLog(options: {
  dir: string;
  now?: () => string;
}): ReadAuditLog {
  const file = path.join(options.dir, "read-access.jsonl");
  const now = options.now ?? (() => new Date().toISOString());
  return {
    record(event: ReadAuditEvent): void {
      mkdirSync(options.dir, { recursive: true, mode: 0o700 });
      appendFileSync(file, `${JSON.stringify({ ...event, at: event.at || now() })}\n`, {
        mode: 0o600,
      });
    },
  };
}

/** 从工具参数中提取可记录的对象标识（白名单，绝不记录任意参数）。 */
export function readAuditObjectId(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (tool === "kiwi_merchant_get_a2a_negotiation" && typeof args.negotiation_id === "string") {
    return args.negotiation_id;
  }
  if (tool === "kiwi_merchant_get_operations_report" && typeof args.period === "string") {
    return args.period;
  }
  return undefined;
}

/** 提取工具结果中的稳定错误码（只读工具错误带 structuredContent.error.code）。 */
function readErrorCode(result: MerchantMcpCallResult): string | undefined {
  const error = result.structuredContent?.error;
  if (typeof error === "object" && error !== null) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return undefined;
}

/**
 * 记录一次只读工具调用。
 *
 * 返回 false 表示本次工具不在审计范围；记录失败会抛出，调用方须转换成
 * 错误结果并拒绝返回数据。
 */
export function auditReadCall(
  context: ReadAuditContext | undefined,
  tool: string,
  args: Record<string, unknown>,
  result: MerchantMcpCallResult,
): boolean {
  if (context === undefined || !READ_AUDIT_TOOLS.has(tool)) return false;
  const objectId = readAuditObjectId(tool, args);
  const code = result.isError === true ? readErrorCode(result) : undefined;
  context.log.record({
    at: context.now(),
    principal_id: context.principalId,
    merchant_id: context.merchantId,
    tool,
    outcome: result.isError === true ? "error" : "ok",
    ...(code !== undefined ? { code } : {}),
    ...(objectId !== undefined ? { object_id: objectId } : {}),
  });
  return true;
}

/** 审计写入失败时的统一错误结果（不含内部细节）。 */
export function auditFailureResult(): MerchantMcpCallResult {
  return {
    content: [
      {
        type: "text",
        text: "商家操作失败（审计不可用）：已拒绝返回私有数据，请稍后重试或检查服务端审计目录。",
      },
    ],
    structuredContent: {
      error: {
        code: "AUDIT_UNAVAILABLE",
        retryable: true,
        message: "read audit unavailable; private data withheld",
      },
    },
    isError: true,
  };
}
