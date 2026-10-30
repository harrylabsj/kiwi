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
 * 可行动事件检测与渠道文本渲染。
 *
 * 隐私口径：企业微信（群）文本不含私有底价、不含 public_message；个人微信
 * 文本可含底价。两类文本都不含买家协议身份（buyer_ref）。
 */

import type { NegotiationApprovalRecord } from "../../a2a/server/negotiation-approvals.js";
import type { NegotiationOwnerListViewItem } from "../negotiation-observer.js";
import type { NegotiationOpsSnapshot } from "../negotiation-ops.js";
import type { WatchState } from "./state.js";

export interface WatchNotification {
  key: string;
  texts: Record<string, string>;
}

export interface DetectOptions {
  channels: readonly string[];
  /** 同一 (negotiation, sku) 的审批通知冷却。 */
  approvalCooldownMs?: number;
  now: Date;
}

const DEFAULT_APPROVAL_COOLDOWN_MS = 10 * 60 * 1000;

export function money(currency: string, minor: number): string {
  const whole = Math.trunc(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  return `${currency === "CNY" ? "¥" : currency}${whole}.${cents}`;
}

function shortId(id: string): string {
  return id.length <= 24 ? id : `${id.slice(0, 21)}…`;
}

function approvalTexts(
  record: NegotiationApprovalRecord,
  channels: readonly string[],
  kind: "pending" | "approved" | "consumed" | "expired" | "rejected",
): Record<string, string> {
  const texts: Record<string, string> = {};
  const base = [
    `【Kiwi 商家】待审批还价`,
    `SKU ${record.sku} × ${record.quantity}${record.unit !== undefined ? ` ${record.unit}` : ""}`,
    `买家还价 ${money(record.currency, record.buyer_offer_minor)}`,
    ...(record.public_bound_minor !== undefined
      ? [`公开边界 ${money(record.currency, record.public_bound_minor)}`]
      : []),
    `审批 ${record.approval_id}`,
    `磋商 ${shortId(record.negotiation_id)}`,
    "批准后需买家再次还价才会生效。",
  ];
  if (kind !== "pending") {
    const label =
      kind === "approved" ? "已批准" : kind === "consumed" ? "已生效" : kind === "rejected" ? "已拒绝" : "已过期";
    base[0] = `【Kiwi 商家】审批${label}`;
    if (record.approved_minor !== undefined && kind !== "rejected") {
      base.splice(2, 0, `批准价 ${money(record.currency, record.approved_minor)}`);
    }
    base[base.length - 1] = kind === "expired" ? "授权已过期，需重新还价/审批。" : "状态已更新。";
  }
  for (const channel of channels) {
    const lines = [...base];
    if (kind === "pending" && channel === "weixin" && record.floor_minor !== undefined) {
      lines.splice(3, 0, `私有底价 ${money(record.currency, record.floor_minor)}`);
    }
    texts[channel] = lines.join("\n");
  }
  return texts;
}

function negotiationTexts(
  row: NegotiationOwnerListViewItem,
  channels: readonly string[],
  kind: "attention" | "agreement",
): Record<string, string> {
  const text =
    kind === "agreement"
      ? `【Kiwi 商家】磋商已达成非绑定协议\nSKU ${row.sku}${row.quantity !== undefined ? ` × ${row.quantity}` : ""}\n磋商 ${shortId(row.negotiation_id)}`
      : `【Kiwi 商家】买家等待回应\nSKU ${row.sku}${row.quantity !== undefined ? ` × ${row.quantity}` : ""}${row.last_action !== "" ? `\n最近动作 ${row.last_action}` : ""}\n磋商 ${shortId(row.negotiation_id)}`;
  return Object.fromEntries(channels.map((channel) => [channel, text]));
}

export interface DetectResult {
  notifications: WatchNotification[];
  next: WatchState;
}

/**
 * 对比状态与快照，返回待投递通知与推进后的状态。
 * 首次运行（initialized_at 缺省）不回放历史磋商，但现存 pending 审批仍通知。
 */
export function detectNotifications(
  state: WatchState,
  snapshot: NegotiationOpsSnapshot,
  options: DetectOptions,
): DetectResult {
  const nowIso = options.now.toISOString();
  const cooldown = options.approvalCooldownMs ?? DEFAULT_APPROVAL_COOLDOWN_MS;
  const firstRun = state.initialized_at === undefined;
  const next: WatchState = {
    version: 1,
    updated_at: nowIso,
    ...(state.initialized_at !== undefined ? { initialized_at: state.initialized_at } : { initialized_at: nowIso }),
    negotiations: { ...state.negotiations },
    approvals: { ...state.approvals },
    queue: state.queue,
  };
  const notifications: WatchNotification[] = [];

  for (const row of snapshot.negotiations) {
    const previous = state.negotiations[row.negotiation_id];
    const newDigest =
      row.last_event_digest !== "" && previous?.last_event_digest !== row.last_event_digest;
    if (newDigest && !firstRun) {
      if (row.needs_attention) {
        notifications.push({
          key: `neg:${row.negotiation_id}:${row.last_event_digest}`,
          texts: negotiationTexts(row, options.channels, "attention"),
        });
      } else if (row.agreement && !previous?.agreement) {
        notifications.push({
          key: `neg:${row.negotiation_id}:${row.last_event_digest}:agreement`,
          texts: negotiationTexts(row, options.channels, "agreement"),
        });
      }
    }
    next.negotiations[row.negotiation_id] = {
      last_event_digest: row.last_event_digest,
      agreement: row.agreement,
      ...(previous?.last_notified_at !== undefined
        ? { last_notified_at: previous.last_notified_at }
        : {}),
    };
  }

  for (const record of snapshot.approvals) {
    const previous = state.approvals[record.approval_id];
    const changed =
      previous === undefined ||
      previous.status !== record.status ||
      previous.updated_at !== record.updated_at;
    if (!changed) continue;

    const transitionKind =
      record.status === "pending"
        ? "pending"
        : previous?.status === "approved" && record.status === "consumed"
          ? "consumed"
          : previous?.status === "approved" && record.status === "expired"
            ? "expired"
            : record.status === "rejected"
              ? "rejected"
              : undefined;

    let notifiedAt = previous?.notified_at;
    if (transitionKind !== undefined) {
      const recentSameSku = Object.values(state.approvals).some(
        (entry) =>
          entry.negotiation_id === record.negotiation_id &&
          entry.sku === record.sku &&
          entry.notified_at !== undefined &&
          options.now.getTime() - Date.parse(entry.notified_at) < cooldown,
      );
      const cooling =
        transitionKind === "pending" &&
        (recentSameSku ||
          (previous?.notified_at !== undefined &&
            options.now.getTime() - Date.parse(previous.notified_at) < cooldown));
      if (!cooling) {
        notifications.push({
          key: `nap:${record.approval_id}:${record.status}:${record.updated_at}`,
          texts: approvalTexts(record, options.channels, transitionKind),
        });
        notifiedAt = nowIso;
      }
    }
    next.approvals[record.approval_id] = {
      status: record.status,
      updated_at: record.updated_at,
      negotiation_id: record.negotiation_id,
      sku: record.sku,
      ...(notifiedAt !== undefined ? { notified_at: notifiedAt } : {}),
    };
  }

  return { notifications, next };
}
