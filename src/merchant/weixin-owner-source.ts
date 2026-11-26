/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { readAdminCredentials } from "../auth/merchant-sessions.js";
import { LedgerStore } from "../negotiation/ledger/index.js";
import { TERMINAL_PHASES } from "../negotiation/state/phase.js";
import { OwnerConversationError, type OwnerInquiry, type OwnerInquirySource, type WeixinOwnerConversationOptions } from "./weixin-owner-conversation.js";
import type { ExactMerchantProduct } from "../agent/merchant/types.js";
import { createOwnerInventoryReader } from "./weixin-owner-inventory.js";
import type { WeixinOwnerAgent } from "./weixin-owner-agent.js";

const INBOUND_ACTIONS = new Set(["inquiry", "rfq", "offer", "counter_offer", "clarification"]);
const MAX_LEDGER_CHAINS = 1000;

/** 读取当前商家 A2A 账本；不把协议里的报价有效期当作回复 SLA。 */
export function createOwnerA2aInquirySource(dataDir: string, localAgent: string): OwnerInquirySource {
  const dir = path.join(dataDir, "a2a");
  const open = () => {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new OwnerConversationError("unavailable", "商家 A2A 账本未装配。");
    }
    return new LedgerStore({ dir });
  };
  /** 绑定校验 + 最后一条买家入站筛选（待回复判定与区间统计共用，不携带买家正文）。 */
  function lastInbound(ledger: LedgerStore, id: string) {
    const events = ledger.verifiedEvents(id);
    const marker = events.find((event) => event.event_kind === "reconciliation" &&
      event.identity.actor === "merchant" && event.identity.sender_identity === localAgent &&
      event.outcome.kind === "ok" &&
      (event.outcome.result?.peer_binding as { type?: unknown; version?: unknown } | undefined)?.type === "merchant-peer-binding" &&
      (event.outcome.result?.peer_binding as { version?: unknown } | undefined)?.version === 1);
    if (marker === undefined) return undefined;
    const inbound = events.filter((event) => event.event_kind === "message_received").at(-1);
    if (inbound === undefined || inbound.identity.actor !== "buyer" || inbound.message_id === undefined ||
        inbound.identity.sender_identity !== marker.identity.counterparty_identity) return undefined;
    const wire = ledger.resolvePayload(inbound).wire_payload as { action?: string; payload?: { items?: unknown; terms?: { items?: unknown } } } | undefined;
    if (wire?.action === undefined || !INBOUND_ACTIONS.has(wire.action)) return undefined;
    const receivedAt = Date.parse(inbound.recorded_at);
    if (!Number.isFinite(receivedAt)) return undefined;
    return { events, inbound, wire, receivedAt };
  }
  function read(ledger: LedgerStore, id: string): OwnerInquiry | undefined {
    const hit = lastInbound(ledger, id);
    if (hit === undefined) return undefined;
    const { events, inbound, wire, receivedAt } = hit;
    const phase = events.filter((event) => event.state_transition !== undefined).at(-1)?.state_transition?.to_phase;
    if (phase !== undefined && (TERMINAL_PHASES as readonly string[]).includes(phase)) return undefined;
    // 出站可先于对应入站回执落账；显式 in_reply_to 与时间都必须核对。
    if (events.some((event) => event.event_kind === "message_sent" &&
      (event.in_reply_to === inbound.message_id || event.occurred_at >= inbound.occurred_at))) return undefined;
    const version = events.at(-1)?.event_digest;
    if (!version) return undefined;
    const items = wire.payload?.items ?? wire.payload?.terms?.items;
    const first = Array.isArray(items) ? items[0] as { sku?: unknown; quantity?: { value?: unknown } } | undefined : undefined;
    const sku = first?.sku;
    const quantity = first?.quantity?.value;
    return { id, version, receivedAt,
      ...(typeof sku === "string" && /^[\p{L}\p{N}._-]{1,64}$/u.test(sku) ? { sku } : {}),
      ...(typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0 ? { quantity } : {}) };
  }
  return {
    list() {
      const ledger = open();
      const ids = ledger.listNegotiations();
      if (ids.length > MAX_LEDGER_CHAINS) throw new OwnerConversationError("unavailable", "试点询价视图超出查询容量。");
      return ids.flatMap((id) => {
        const value = read(ledger, id);
        return value === undefined ? [] : [value];
      });
    },
    get(id) { return read(open(), id); },
    rangeStats(since) {
      if (!Number.isSafeInteger(since)) throw new OwnerConversationError("invalid_input", "统计区间起点无效。");
      const ledger = open();
      const ids = ledger.listNegotiations();
      if (ids.length > MAX_LEDGER_CHAINS) throw new OwnerConversationError("unavailable", "试点询价视图超出查询容量。");
      let inquiries = 0, pending = 0;
      for (const id of ids) {
        const hit = lastInbound(ledger, id);
        if (hit === undefined || hit.receivedAt < since) continue;
        inquiries += 1;
        if (read(ledger, id) !== undefined) pending += 1;
      }
      return { inquiries, pending };
    },
  };
}

/** 浏览器登录仅用于配对；持久通道授权绑定当前真实管理员凭据代次。 */
export function createWorkbenchWeixinOwnerOptions(input: {
  flag: string | undefined;
  /** 单独启用私聊回信；工作台预览开关绝不会打开微信回信。 */
  replyFlag?: string;
  agent?: WeixinOwnerAgent;
  dataDir: string;
  adminDir: string;
  merchantId: string;
  agentId: string;
  origin: string | undefined;
  readExactProduct?: (sku: string) => Promise<ExactMerchantProduct>;
}): WeixinOwnerConversationOptions {
  let origin: string | undefined;
  try {
    const url = new URL(input.origin ?? "");
    if (url.protocol === "https:" && url.username === "" && url.password === "") origin = url.origin;
  } catch { /* 未装配可信 origin 时不启用 */ }
  const replyToOwner = input.replyFlag === "1";
  return {
    enabled: replyToOwner || input.flag === "1" && origin !== undefined,
    replyToOwner,
    ...(replyToOwner && input.agent !== undefined ? { agent: input.agent } : {}),
    workbenchOrigin: origin ?? "https://invalid.invalid",
    source: createOwnerA2aInquirySource(input.dataDir, input.agentId),
    ...(input.readExactProduct !== undefined ? { inventory: createOwnerInventoryReader(input.merchantId, input.readExactProduct) } : {}),
    ownerRevision(principal) {
      try {
        const owner = readAdminCredentials(input.adminDir);
        if (owner?.merchant_id !== input.merchantId || owner.principal_id !== principal ||
            typeof owner.password_hash !== "string" || !Number.isFinite(Date.parse(owner.created_at))) return undefined;
        return createHash("sha256").update(JSON.stringify([owner.principal_id, owner.created_at, owner.password_hash])).digest("hex");
      } catch { return undefined; }
    },
  };
}
