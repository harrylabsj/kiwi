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
 * 店主经营操作层：磋商旁观（owner 投影）与还价审批的唯一业务入口。
 *
 * 本机 `/ops` HTTP 面与 watch 通知服务都只调用本层，避免两套读/写实现漂移。
 * 默认旁观投影（`list()/timeline()`）仍是零金额隐私口径；本层只调用
 * `listOwner()/timelineOwner()`，因此金额只在 loopback `/ops` 与店主通知里出现。
 *
 * 审批写入口径：低于私有底价的批准在本层直接拒绝（`below_floor`），
 * CLI `kiwi merchant approvals approve` 保持既有能力（确需亏损成交走 CLI）。
 */

import type {
  NegotiationOwnerListResult,
  NegotiationOwnerListViewItem,
  NegotiationOwnerTimelineView,
  NegotiationStatusFilter,
} from "./negotiation-observer.js";
import { createNegotiationObserver } from "./negotiation-observer.js";
import type {
  NegotiationApprovalRecord,
  NegotiationApprovalStatus,
  NegotiationApprovalStore,
} from "../a2a/server/negotiation-approvals.js";

export type NegotiationOpsErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "forbidden"
  | "internal";

const STATUS_BY_CODE: Record<NegotiationOpsErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  forbidden: 403,
  internal: 500,
};

export class NegotiationOpsError extends Error {
  readonly code: NegotiationOpsErrorCode;
  readonly status: number;
  /** 机器可读的细分原因（如 below_floor），不参与文案。 */
  readonly reason?: string;

  constructor(code: NegotiationOpsErrorCode, message: string, reason?: string) {
    super(message);
    this.name = "NegotiationOpsError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    if (reason !== undefined) this.reason = reason;
  }
}

export interface NegotiationOpsApproveInput {
  approval_id: string;
  approved_minor: number;
  ttl_seconds?: number;
  actor: string;
}

export interface NegotiationOpsRejectInput {
  approval_id: string;
  reason?: string;
  actor: string;
}

export interface NegotiationOpsSnapshot {
  negotiations: NegotiationOwnerListViewItem[];
  total: number;
  approvals: NegotiationApprovalRecord[];
}

export interface NegotiationOps {
  info(): { merchant_id: string; version: string; ledger_negotiations: number };
  listNegotiations(query: {
    status?: NegotiationStatusFilter;
    cursor?: string;
    limit?: number;
  }): NegotiationOwnerListResult;
  negotiationDetail(negotiationId: string): NegotiationOwnerTimelineView;
  listApprovals(status?: NegotiationApprovalStatus | "all"): NegotiationApprovalRecord[];
  approve(input: NegotiationOpsApproveInput): NegotiationApprovalRecord;
  reject(input: NegotiationOpsRejectInput): NegotiationApprovalRecord;
  /** watch 轮询用的最小快照（owner 列表 + 全部审批）。 */
  snapshot(): NegotiationOpsSnapshot;
}

export interface NegotiationOpsOptions {
  ledgerDir: string;
  approvals: NegotiationApprovalStore;
  merchantId: string;
  version: string;
  now?: () => string;
}

const APPROVAL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "consumed",
  "expired",
  "rejected",
]);

function requireText(value: unknown, field: string, max = 128): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || text.length > max) {
    throw new NegotiationOpsError("invalid_request", `${field} 必须是非空字符串（≤${max} 字符）`);
  }
  return text;
}

function optionalStatus(value: unknown): NegotiationApprovalStatus | "all" {
  if (value === undefined || value === "" || value === "all") return "all";
  if (typeof value === "string" && APPROVAL_STATUSES.has(value)) {
    return value as NegotiationApprovalStatus;
  }
  throw new NegotiationOpsError("invalid_request", "status 不是合法的审批状态");
}

function mapStoreError(err: unknown): NegotiationOpsError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("no pending negotiation approval")) {
    return new NegotiationOpsError("conflict", "该审批已处理或已过期");
  }
  if (message.includes("reject reason")) {
    return new NegotiationOpsError("invalid_request", "拒绝原因过长（≤500 字符）");
  }
  if (message.includes("locked by another process")) {
    return new NegotiationOpsError("conflict", "审批队列正被另一个进程写入，请重试");
  }
  return new NegotiationOpsError("internal", "审批写入失败");
}

export function createNegotiationOps(options: NegotiationOpsOptions): NegotiationOps {
  const observer = createNegotiationObserver({
    ledgerDir: options.ledgerDir,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const findApproval = (approvalId: string): NegotiationApprovalRecord | undefined =>
    options.approvals.list().find((record) => record.approval_id === approvalId);

  const notFoundLedger = (err: unknown): never => {
    if (err instanceof Error && err.name === "MerchantWorkbenchError") {
      const kind = (err as Error & { kind?: string }).kind;
      if (kind === "unavailable") {
        throw new NegotiationOpsError("unavailable", "磋商账本不可读");
      }
      if (kind === "validation") {
        throw new NegotiationOpsError("invalid_request", "磋商查询参数不合法");
      }
      if (kind === "not_found") {
        throw new NegotiationOpsError("not_found", "未找到该磋商");
      }
    }
    throw new NegotiationOpsError("internal", "磋商读取失败");
  };

  return {
    info() {
      try {
        const all = observer.listOwner({ status: "all", limit: 1 });
        return {
          merchant_id: options.merchantId,
          version: options.version,
          ledger_negotiations: all.total,
        };
      } catch (err) {
        return notFoundLedger(err);
      }
    },

    listNegotiations(query) {
      try {
        return observer.listOwner(query);
      } catch (err) {
        return notFoundLedger(err);
      }
    },

    negotiationDetail(negotiationId) {
      try {
        return observer.timelineOwner(requireText(negotiationId, "negotiation_id"));
      } catch (err) {
        if (err instanceof NegotiationOpsError) throw err;
        return notFoundLedger(err);
      }
    },

    listApprovals(status) {
      const resolved = optionalStatus(status);
      return options.approvals.list(resolved === "all" ? undefined : resolved);
    },

    approve(input) {
      const approvalId = requireText(input.approval_id, "approval_id");
      if (!Number.isSafeInteger(input.approved_minor) || input.approved_minor < 0) {
        throw new NegotiationOpsError("invalid_request", "approved_minor 必须是非负整数");
      }
      const actor = requireText(input.actor, "actor");
      const ttl = input.ttl_seconds ?? 3600;
      if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86_400) {
        throw new NegotiationOpsError("invalid_request", "ttl_seconds 必须是 60..86400 的整数");
      }
      const current = findApproval(approvalId);
      if (current === undefined) {
        throw new NegotiationOpsError("not_found", "未找到该审批");
      }
      if (current.status !== "pending") {
        throw new NegotiationOpsError("conflict", "该审批已处理或已过期");
      }
      if (current.floor_minor !== undefined && input.approved_minor < current.floor_minor) {
        throw new NegotiationOpsError("invalid_request", "批准价低于私有底价", "below_floor");
      }
      try {
        return options.approvals.approve({
          approval_id: approvalId,
          approved_minor: input.approved_minor,
          ttl_seconds: ttl,
          approved_by: actor,
        });
      } catch (err) {
        throw mapStoreError(err);
      }
    },

    reject(input) {
      const approvalId = requireText(input.approval_id, "approval_id");
      const actor = requireText(input.actor, "actor");
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (reason.length > 500) {
        throw new NegotiationOpsError("invalid_request", "拒绝原因过长（≤500 字符）");
      }
      const current = findApproval(approvalId);
      if (current === undefined) {
        throw new NegotiationOpsError("not_found", "未找到该审批");
      }
      if (current.status !== "pending") {
        throw new NegotiationOpsError("conflict", "该审批已处理或已过期");
      }
      try {
        return options.approvals.reject({
          approval_id: approvalId,
          ...(reason !== "" ? { reason } : {}),
          rejected_by: actor,
        });
      } catch (err) {
        throw mapStoreError(err);
      }
    },

    snapshot() {
      try {
        const all = observer.listOwner({ status: "all", limit: 100 });
        return {
          negotiations: all.items,
          total: all.total,
          approvals: options.approvals.list(),
        };
      } catch (err) {
        return notFoundLedger(err);
      }
    },
  };
}
