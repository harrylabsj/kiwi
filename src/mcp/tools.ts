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
 * 高层 Kiwi Sourcing Tools（战略 v2.5 §6.1，词表单一来源见 KIWI_SOURCING_TOOLS）：
 * 9 个采购/审批工具 + 4 个买家关注工具（M4 拉取式订阅）。
 *
 * 原则：不暴露 KNP 每个底层消息、不复制 UCP 的 Catalog/Checkout tools；宿主 Agent
 * 用少量跨 Merchant 高层工具完成『找供应商 → RFQ → 比较 → 磋商 → Agreement →
 * UCP handoff』编排，买家关注工具只做显式关注/取消/列表/主动拉取公开动态（不把
 * 商家运营工具暴露给买方）。每个写工具绑定 idempotency_key 并返回稳定 task_id /
 * candidate_id / approval_id / agreement_id（§6.2）。业务错误经 isError 带内返回，
 * 错误分类（McpError.code）作为跨宿主语义不变量（§6.10）。
 */

import { installProcurementTools, type BuyerToolProfile, type ProcurementToolOptions } from "./procurement-tools.js";
import type { McpCallToolResult, KiwiToolDefinition } from "./types.js";
import { McpError } from "../buyer-core/errors.js";
import { KiwiBuyerService } from "../buyer-core/service.js";
import { DESTINATION_TYPES } from "../handoff/destination.js";
import { tr } from "../i18n.js";

function counterTarget(value: unknown): { currency: string; amount_minor: number } | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && "currency" in value && "amount_minor" in value) {
    const { currency, amount_minor } = value;
    if (typeof currency === "string" && /^[A-Z]{3}$/.test(currency) &&
        typeof amount_minor === "number" && Number.isSafeInteger(amount_minor) && amount_minor > 0) {
      return { currency, amount_minor };
    }
  }
  throw new McpError("invalid_params", "请提供还价币种和正整数最小货币单位金额。");
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new McpError("invalid_params", `Expected a non-empty ${key}`);
  return value;
}

function ok(text: string): McpCallToolResult {
  return { content: [{ type: "text", text }] };
}

function err(error: unknown): McpCallToolResult {
  if (error instanceof McpError) {
    const result: McpCallToolResult = {
      content: [{ type: "text", text: `error ${error.code}: ${error.message}` }],
      isError: true,
    };
    if (error.code === "clarification_needed" && error.detail && typeof error.detail === "object") {
      result.structuredContent = { ...error.detail, code: error.code };
    }
    return result;
  }
  return {
    content: [
      {
        type: "text",
        text: "error internal_error: Tool operation failed",
      },
    ],
    isError: true,
  };
}

/**
 * ASK 动作遇 approval_required 时的结构化返回：不抛 isError，而是返回
 * `{ approval_required: { approval_id }, ...extra }`——宿主拿到持久 approval_id
 * 呈现给用户确认后调 kiwi_approve，再携 id 重试。approval_id 是 first-class 值，
 * 不从错误文本解析。
 */
function approvalRequiredOrErr(error: unknown, extra: Record<string, unknown>): McpCallToolResult {
  if (error instanceof McpError && error.code === "approval_required") {
    const approvalId = (error.detail as { approval_id?: string } | undefined)?.approval_id;
    return ok(JSON.stringify({ approval_required: { approval_id: approvalId }, ...extra }));
  }
  return err(error);
}

/** 构造全部高层工具。任意 handler 抛出的 McpError 都会被转成 isError 结果。 */
export function buildKiwiTools(service: KiwiBuyerService, profile: BuyerToolProfile = "legacy13", options: ProcurementToolOptions & { targetedNegotiation?: boolean } = {}): KiwiToolDefinition[] {
  const targetedNegotiation = profile === "legacy13" && options.targetedNegotiation === true;
  const tools: Array<KiwiToolDefinition & { raw?: boolean }> = [
    {
      name: "kiwi_search",
      description:
        tr(
          "Discover candidate suppliers and search products across merchants on demand. Read-only. Search is global within the Kiwi Network, the legacy region parameter is ignored, and delivery timing is confirmed separately. Covers the Kiwi Network (in-network merchants) only: internet e-commerce listings are out of scope and must be retrieved with the host's own web tools; never present this result as external platform data. Internals: merchant routing + UCP Catalog orchestration + trust/freshness. The returned network_search reports the true state of this Network query (status: completed/partial/timeout/error/not_searched; result_state: has_candidates/no_match/undetermined) - only completed + no_match may be phrased as 'no match this time'; timeouts, failures, partial completion, or not-searched must never be reported as 'no suppliers available'. Merchants with inquiry_available=true support live quote requests (proceed to kiwi_request_quotes); merchants with inquiry_available=false and source_kind=merchant_declared only have their v0 public profile (browsable: product names, updated-at, storefront link) and cannot be queried for quotes. products is a projection of the merchant's existing profile (basis=merchant_listed; price.kind=merchant_listed_price means the merchant's listed price, absent means to_be_quoted) - never present it as a confirmed quote, stock, or lead-time commitment.",
          "发现候选供应商，并按需跨商家搜索商品。只读。在 Kiwi Network 内全球搜索，旧版 region 参数不参与筛选，到货时间另行确认。只覆盖 Kiwi Network（Kiwi 网络内商家）：互联网电商商品不在本工具范围内，须由宿主自身的检索/取页工具完成，不得用本结果冒充外部平台信息。内部语义：Merchant routing + UCP Catalog orchestration + trust/freshness。返回 network_search 说明本次 Network 查询的真实状态（status: completed/partial/timeout/error/not_searched；result_state: has_candidates/no_match/undetermined）——只有 completed + no_match 才能说「本次没有匹配」；超时、失败、部分完成、未搜索都不得表述为「没有供应商」。结果中 inquiry_available=true 的商家可实时询价（可进入 kiwi_request_quotes）；inquiry_available=false 且 source_kind=merchant_declared 的商家仅有第 0 版公开资料（资料可查，含命中商品名/更新时间/店铺入口），不可发起询价。products 是商家既有资料投影（basis=merchant_listed；price.kind=merchant_listed_price 为商家资料价，无价则 to_be_quoted），未经本次询价确认，不得当作报价、库存或交期承诺。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1 },
          category: { type: "string" },
          region: {
            type: "string",
            deprecated: true,
            description: tr(
              "Ignored. Kiwi Network search is global. Confirm delivery timing separately.",
              "此参数已弃用。Kiwi Network 在全球范围内搜索，到货时间另行确认。",
            ),
          },
        },
      },
      async handle(args) {
        try {
          const result = await service.search({
            query: requiredString(args, "query"),
            category: args.category === undefined ? undefined : String(args.category),
          });
          // 旧字段 merchants/note 原样保留（已发布宿主在用）；
          // network_search 为增量字段：本次 Network 查询的结构化状态。
          return ok(
            JSON.stringify({
              merchants: result.merchants,
              note: result.note,
              network_search: result.network_search,
            }),
          );
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_request_quotes",
      description:
        tr(
          "Send an RFQ to one or more merchants. Write op; pass an idempotency_key (optional, auto-generated when omitted) and get back a stable task_id; KNP RFQ fan-out. CommerceIntent must satisfy the frozen contract: every intent.items entry needs query (short product word) and quantity ({value, unit} object, e.g. {\"value\":2,\"unit\":\"unit\"}). Example intent.items: [{\"query\":\"thermos cup\",\"quantity\":{\"value\":2,\"unit\":\"unit\"}}]. merchant_ids only accepts merchants with inquiry_available=true from kiwi_search; merchants with only a v0 public profile are rejected by the service layer (merchant_inquiry_unavailable), and merchants currently offline (heartbeat timeout, freshness_state=stale/unreachable) are rejected (merchant_offline) - neither produces a task. constraints.budget MUST be a money object {currency, amount_minor} using integer minor units (e.g. 150 yuan = {\"currency\":\"CNY\",\"amount_minor\":15000}); a bare number is rejected by the frozen contract. constraints.target_unit_price uses the same shape.",
          '向一个或多个商家发起询价。写操作；必须携带 idempotency_key（可选，缺省自动生成），返回稳定 task_id；KNP RFQ fan-out。CommerceIntent 必须满足冻结契约：intent.items 每项必须有 query（商品短词）与 quantity（{value, unit} 对象，如 {"value":2,"unit":"台"}）。示例 intent.items: [{"query":"保温杯","quantity":{"value":2,"unit":"台"}}]。merchant_ids 仅接受 kiwi_search 中 inquiry_available=true 的商家；仅有第 0 版公开资料的商家会被服务层拒绝（merchant_inquiry_unavailable），服务当前不在线（心跳超时、freshness_state=stale/unreachable）的商家会被拒绝（merchant_offline），两者都不产生任务。constraints.budget 必须是 money 对象 {currency, amount_minor}，金额用最小单位整数（如 150 元 = {"currency":"CNY","amount_minor":15000}）；裸数字会被冻结契约拒绝。constraints.target_unit_price 同形状。',
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["intent"],
        properties: {
          intent: {
            type: "object",
            additionalProperties: true,
            required: ["intent_id", "intent_type", "items"],
            properties: {
              intent_id: { type: "string", minLength: 1 },
              intent_type: { type: "string", enum: ["purchase", "procurement", "inquiry"] },
              items: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: true,
                  required: ["query"],
                  properties: {
                    query: {
                      type: "string",
                      minLength: 1,
                      description: tr(
                        "Short product word (e.g. thermos cup); matches catalog title/category via LIKE; long spec phrases may not match",
                        "商品短词（如 保温杯），命中 catalog 标题/分类 LIKE；长规格词可能匹配不到",
                      ),
                    },
                    sku: { type: "string", minLength: 1 },
                    quantity: {
                      type: "object",
                      required: ["value", "unit"],
                      properties: {
                        value: { type: "number", exclusiveMinimum: 0 },
                        unit: { type: "string", minLength: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
          idempotency_key: { type: "string", minLength: 1 },
          merchant_ids: { type: "array", items: { type: "string", minLength: 1 } },
          reuse_history: {
            type: "boolean",
            description: tr(
              "Reuse-last-spec revisit: query this merchant's previously published quotes for the buyer first (requires authorization); a unique match sends the standard RFQ with that SKU and this call's quantity. Explicit sku in intent takes precedence. No history / ambiguous / unsupported returns a clarification object instead of creating a task.",
              "沿用上次规格回访：先按本店授权查询上次已发报价（需委托授权）；唯一匹配则以该 SKU 加本次数量走标准 RFQ。intent 已显式给 sku 时以新规格为准。无历史/多义/不支持时返回结构化 clarification，不创建任务。",
            ),
          },
        },
      },
      async handle(args) {
        try {
          const result = await service.requestQuotes({
            intent: (args.intent ?? {}) as Record<string, unknown>,
            idempotency_key:
              args.idempotency_key === undefined ? undefined : String(args.idempotency_key),
            merchant_ids:
              args.merchant_ids === undefined
                ? undefined
                : (args.merchant_ids as string[]).map(String),
            reuse_history: args.reuse_history === undefined ? undefined : args.reuse_history === true,
          });
          return ok(
            JSON.stringify({
              task_id: result.task.task_id,
              task: result.task,
              created: result.created,
              ...(result.reused_history !== undefined ? { reused_history: result.reused_history } : {}),
            }),
          );
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_get_task",
      description:
        tr(
          "Read task status, quotes, partial failures, pending approvals, and expiry info. Unified status/resume read surface; replaces keeping offer/pending state in plugin memory.",
          "读取任务状态、报价、部分失败、待审批与过期信息。统一 status/resume 读取面；替代把 offer/pending 状态放在插件内存。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["task_id"],
        properties: { task_id: { type: "string", minLength: 1 } },
      },
      async handle(args) {
        try {
          return ok(JSON.stringify(service.getTask(requiredString(args, "task_id"))));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_negotiate",
      description:
        tr(
          "Negotiate only with an unambiguous candidate. When supported, select candidate_id and pass the authorized target_unit_price with its currency. The budget is a ceiling.",
          "仅向明确的候选磋商。工具公开相应字段时，用 candidate_id 选择候选，用含币种的 target_unit_price 传递授权出价。预算只用于校验上限。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["task_id", "action", "summary"],
        properties: {
          task_id: { type: "string", minLength: 1 },
          action: { type: "string", enum: ["counter_offer", "clarification"] },
          ...(targetedNegotiation ? {
            candidate_id: { type: "string", minLength: 1 },
            target_unit_price: {
              type: "object", additionalProperties: false, required: ["currency", "amount_minor"],
              properties: { currency: { type: "string", pattern: "^[A-Z]{3}$" }, amount_minor: { type: "integer", minimum: 1 } },
            },
          } : {}),
          summary: { type: "string", minLength: 1 },
        },
      },
      async handle(args) {
        try {
          const target = counterTarget(args.target_unit_price);
          const result = await service.negotiate({
            task_id: requiredString(args, "task_id"),
            action: args.action as "counter_offer" | "clarification",
            ...(args.candidate_id !== undefined ? { candidate_id: requiredString(args, "candidate_id") } : {}),
            ...(target ? { target_unit_price: target } : {}),
            summary: requiredString(args, "summary"),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          if (targetedNegotiation && args.candidate_id === undefined && error instanceof McpError && error.message === "TARGET_REQUIRED") {
            return err(new McpError("clarification_needed", "请指定当前任务中获授权的候选。", { reason: "candidate_required" }));
          }
          return err(error);
        }
      },
    },
    {
      name: "kiwi_accept_agreement",
      description:
        tr(
          "Confirm and accept a non-binding agreement. Requires a valid approval_id + candidate_id; outputs a stable agreement_id. When DelegationPolicy=ask and approval is missing, returns approval_required (with a persistent approval_id); retry with that approval_id once the host completes human approval.",
          "请求确认并接受非绑定协议。要求有效 approval_id + candidate_id；输出稳定 agreement_id。DelegationPolicy=ask 时若缺审批会返回 approval_required（含持久 approval_id），宿主完成人工审批后携 approval_id 重试。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["task_id", "candidate_id"],
        properties: {
          task_id: { type: "string", minLength: 1 },
          candidate_id: { type: "string", minLength: 1 },
          approval_id: { type: "string", minLength: 1 },
        },
      },
      async handle(args) {
        try {
          const result = await service.acceptAgreement({
            task_id: requiredString(args, "task_id"),
            candidate_id: requiredString(args, "candidate_id"),
            approval_id: args.approval_id === undefined ? undefined : requiredString(args, "approval_id"),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          return approvalRequiredOrErr(error, {
            task_id: args.task_id,
            candidate_id: args.candidate_id,
          });
        }
      },
    },
    {
      name: "kiwi_get_agreement",
      description:
        tr(
          "Read the final agreement, provenance, and audit summary. Read-only; agreement retrieval + digest + audit summary.",
          "读取最终协议、provenance 与审计摘要。只读；Agreement retrieval + digest + audit summary。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["agreement_id"],
        properties: { agreement_id: { type: "string", minLength: 1 } },
      },
      async handle(args) {
        try {
          return ok(JSON.stringify(service.getAgreement(requiredString(args, "agreement_id"))));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_handoff",
      description:
        tr(
          `Produce the transaction / PO / contact path. Agreement -> UCP Checkout / merchant transaction endpoint. Valid destination_type values: ${DESTINATION_TYPES.join(" | ")}. external_checkout_url and platform_deep_link require a url (use external_checkout_url + the merchant's handoff URL for a storefront checkout page); ucp_checkout / ucp_order / merchant_checkout_session are opaque session refs and must not carry url. When ASK and approval is missing, returns structured approval_required (with approval_id); host runs kiwi_approve then retries with the id. Alipay collection is not supported by this host; it requires the native Kiwi buyer terminal with independent signing and private display.`,
          `生成交易/PO/联系路径。Agreement → UCP Checkout / merchant transaction endpoint。合法 destination_type：${DESTINATION_TYPES.join(" | ")}。external_checkout_url 与 platform_deep_link 必须带 url（商家店铺结算页用 external_checkout_url + 商家 handoff URL）；ucp_checkout / ucp_order / merchant_checkout_session 是 opaque 会话引用，不得带 url。ASK 时缺审批返回结构化 approval_required（含 approval_id），宿主 kiwi_approve 后携 id 重试。支付宝收款不支持此宿主，仅可使用有独立签名身份和私有显示能力的 Kiwi 买家终端。`,
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["agreement_id", "destination_type"],
        properties: {
          agreement_id: { type: "string", minLength: 1 },
          approval_id: { type: "string", minLength: 1 },
          destination_type: { type: "string", minLength: 1 },
          url: { type: "string" },
        },
      },
      async handle(args) {
        try {
          const result = await service.handoff({
            agreement_id: requiredString(args, "agreement_id"),
            approval_id: args.approval_id === undefined ? undefined : requiredString(args, "approval_id"),
            destination_type: requiredString(args, "destination_type"),
            url: args.url === undefined ? undefined : String(args.url),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          return approvalRequiredOrErr(error, {
            agreement_id: args.agreement_id,
            destination_type: args.destination_type,
          });
        }
      },
    },
    {
      name: "kiwi_approve",
      description:
        tr(
          "Approve a persistent approval (ASK gate). Call after the host presents the non-binding agreement / handoff summary to the user and obtains consent; then retry kiwi_accept_agreement / kiwi_handoff with the approval_id. Write op, double-gated by the host's approval system.",
          "批准一个持久审批（ASK 门）。宿主在向用户呈现非绑定协议/交接摘要并获得确认后调用；随后携 approval_id 重试 kiwi_accept_agreement / kiwi_handoff。写操作，受宿主审批系统二次拦截。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["approval_id"],
        properties: {
          approval_id: { type: "string", minLength: 1 },
          note: { type: "string" },
        },
      },
      async handle(args) {
        try {
          return ok(
            JSON.stringify(
              service.approve({
                approval_id: requiredString(args, "approval_id"),
                note: args.note === undefined ? undefined : String(args.note),
              }),
            ),
          );
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_reject",
      description:
        tr(
          "Reject a persistent approval (deny is the preferred path). Once rejected, the same approval_id can no longer be approved or produce an agreement/handoff.",
          "拒绝一个持久审批（deny 优先路径）。拒绝后同一 approval_id 无法再批准或形成协议/交接。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["approval_id"],
        properties: {
          approval_id: { type: "string", minLength: 1 },
          reason: { type: "string" },
        },
      },
      async handle(args) {
        try {
          return ok(
            JSON.stringify(
              service.reject({
                approval_id: requiredString(args, "approval_id"),
                reason: args.reason === undefined ? undefined : String(args.reason),
              }),
            ),
          );
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_follow_merchant",
      description:
        tr(
          "Explicitly follow a merchant (pull-based subscription). Buyer-initiated only: searching, browsing, viewing a profile, or requesting quotes never constitutes a subscription and must not replace the buyer's explicit follow. After following, the buyer can use kiwi_get_follow_updates to check the merchant's public updates on demand; merchants cannot push messages to followers. Requires Kiwi catalog sign-in (returns a sign-in guide when not configured).",
          "显式关注一个商家（拉取式订阅）。仅买家主动调用：搜索、浏览、查看资料或发起询价都不构成订阅，不得因这些行为代替买家关注。关注后买家可用 kiwi_get_follow_updates 主动查看该商家的公开动态；商家无法向关注者推送消息。需要 Kiwi 目录登录态（未配置时返回登录引导）。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["merchant_id"],
        properties: {
          merchant_id: { type: "string", minLength: 1 },
          category: { type: "string", description: tr("Optional: only care about public updates in this category", "可选：只关心该类目的公开动态") },
          consent_version: { type: "string", description: tr("Optional: the version of the subscription terms the buyer consented to", "可选：买家同意的订阅条款版本") },
        },
      },
      async handle(args) {
        try {
          const result = await service.followMerchant({
            merchant_id: args.merchant_id === undefined ? "" : String(args.merchant_id),
            category: args.category === undefined ? undefined : String(args.category),
            consent_version:
              args.consent_version === undefined ? undefined : String(args.consent_version),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_unfollow_merchant",
      description:
        tr(
          "Unfollow a merchant (idempotent). Buyer-initiated only; after unfollowing, the merchant leaves the follow list and its public updates are no longer shown.",
          "取消关注一个商家（幂等）。仅买家主动调用；取消后该商家不再出现在关注列表，也不再展示其公开动态更新。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["merchant_id"],
        properties: {
          merchant_id: { type: "string", minLength: 1 },
        },
      },
      async handle(args) {
        try {
          const result = await service.unfollowMerchant({
            merchant_id: args.merchant_id === undefined ? "" : String(args.merchant_id),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_list_follows",
      description:
        tr(
          "List the buyer's currently followed merchants (follow management surface). Read-only; requires Kiwi catalog sign-in (returns a sign-in guide when not configured).",
          "列出买家当前活跃关注的商家（关注管理面）。只读；需要 Kiwi 目录登录态（未配置时返回登录引导）。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async handle() {
        try {
          return ok(JSON.stringify(await service.listFollows()));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_get_follow_updates",
      description:
        tr(
          "Check public updates from followed merchants. Call only in response to an explicit buyer ask (e.g. 'any new updates from merchants I follow?'): returns the merchants' public updates incrementally by watermark (product_added / product_updated / faq_updated / service_notice / publication_withdrawn, public fields only), acknowledge processed groups on the next call using watermarks (merchant_id to last_seen_at). Pull-based subscription: merchants cannot push messages to the buyer, and this tool never receives merchant DMs on the buyer's behalf.",
          "查看买家关注的商家有什么公开更新。仅响应买家主动询问（如“我关注的商家有什么新动态”）时调用：按水位增量返回商家公开动态（product_added / product_updated / faq_updated / service_notice / publication_withdrawn，仅公开字段），处理成功后下次用 watermarks 确认各商家的 last_seen_at；未确认的目录更新可重读。拉取式订阅：商家无法向买家推送消息，本工具也不代表买家接收任何商家私信。",
        ),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: { watermarks: { type: "object", maxProperties: 500, additionalProperties: { type: "string" } } },
      },
      async handle(args) {
        try {
          return ok(JSON.stringify(await service.getFollowUpdates(args.watermarks as Record<string, string> | undefined)));
        } catch (error) {
          return err(error);
        }
      },
    },
  ];
  const legacy = tools.map(({ raw: _raw, ...t }) => t);
  return profile === "company-procurement-v1" ? installProcurementTools(legacy, service, options) : legacy;
}
