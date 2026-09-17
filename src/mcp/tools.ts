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

import type { McpCallToolResult, KiwiToolDefinition } from "./types.js";
import { McpError } from "../buyer-core/errors.js";
import { KiwiBuyerService } from "../buyer-core/service.js";

function ok(text: string): McpCallToolResult {
  return { content: [{ type: "text", text }] };
}

function err(error: unknown): McpCallToolResult {
  if (error instanceof McpError) {
    return {
      content: [{ type: "text", text: `error ${error.code}: ${error.message}` }],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `error internal_error: ${error instanceof Error ? error.message : String(error)}`,
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
export function buildKiwiTools(service: KiwiBuyerService): KiwiToolDefinition[] {
  const tools: Array<KiwiToolDefinition & { raw?: boolean }> = [
    {
      name: "kiwi_search",
      description:
        "发现候选供应商，并按需跨商家搜索商品。只读。内部语义：Merchant routing + UCP Catalog orchestration + trust/freshness。结果中 inquiry_available=true 的商家可实时询价（可进入 kiwi_request_quotes）；inquiry_available=false 且 source_kind=merchant_declared 的商家仅有第 0 版公开资料（资料可查，含命中商品名/更新时间/店铺入口），不可发起询价。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1 },
          category: { type: "string" },
          region: { type: "string" },
        },
      },
      async handle(args) {
        try {
          const result = await service.search({
            query: String(args.query),
            category: args.category === undefined ? undefined : String(args.category),
            region: args.region === undefined ? undefined : String(args.region),
          });
          return ok(JSON.stringify({ merchants: result.merchants, note: result.note }));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_request_quotes",
      description:
        '向一个或多个商家发起询价。写操作；必须携带 idempotency_key（可选，缺省自动生成），返回稳定 task_id；KNP RFQ fan-out。CommerceIntent 必须满足冻结契约：intent.items 每项必须有 query（商品短词）与 quantity（{value, unit} 对象，如 {"value":2,"unit":"台"}）。示例 intent.items: [{"query":"保温杯","quantity":{"value":2,"unit":"台"}}]。merchant_ids 仅接受 kiwi_search 中 inquiry_available=true 的商家；仅有第 0 版公开资料的商家会被服务层拒绝（merchant_inquiry_unavailable），不产生任务。',
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
                      description:
                        "商品短词（如 保温杯），命中 catalog 标题/分类 LIKE；长规格词可能匹配不到",
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
          });
          return ok(
            JSON.stringify({
              task_id: result.task.task_id,
              task: result.task,
              created: result.created,
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
        "读取任务状态、报价、部分失败、待审批与过期信息。统一 status/resume 读取面；替代把 offer/pending 状态放在插件内存。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["task_id"],
        properties: { task_id: { type: "string", minLength: 1 } },
      },
      async handle(args) {
        try {
          return ok(JSON.stringify(service.getTask(String(args.task_id))));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_negotiate",
      description:
        "在委托边界内推进磋商。更新同一 task_id；CounterOffer / Clarification；可产生 candidate_id；受 DelegationPolicy max_rounds 等硬约束。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["task_id", "action", "summary"],
        properties: {
          task_id: { type: "string", minLength: 1 },
          action: { type: "string", enum: ["counter_offer", "clarification"] },
          summary: { type: "string", minLength: 1 },
        },
      },
      async handle(args) {
        try {
          const result = await service.negotiate({
            task_id: String(args.task_id),
            action: args.action as "counter_offer" | "clarification",
            summary: String(args.summary),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_accept_agreement",
      description:
        "请求确认并接受非绑定协议。要求有效 approval_id + candidate_id；输出稳定 agreement_id。DelegationPolicy=ask 时若缺审批会返回 approval_required（含持久 approval_id），宿主完成人工审批后携 approval_id 重试。",
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
            task_id: String(args.task_id),
            candidate_id: String(args.candidate_id),
            approval_id: args.approval_id === undefined ? undefined : String(args.approval_id),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          return approvalRequiredOrErr(error, {
            task_id: String(args.task_id),
            candidate_id: String(args.candidate_id),
          });
        }
      },
    },
    {
      name: "kiwi_get_agreement",
      description:
        "读取最终协议、provenance 与审计摘要。只读；Agreement retrieval + digest + audit summary。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["agreement_id"],
        properties: { agreement_id: { type: "string", minLength: 1 } },
      },
      async handle(args) {
        try {
          return ok(JSON.stringify(service.getAgreement(String(args.agreement_id))));
        } catch (error) {
          return err(error);
        }
      },
    },
    {
      name: "kiwi_handoff",
      description:
        "生成交易/PO/联系路径。Agreement → UCP Checkout / merchant transaction endpoint。ASK 时缺审批返回结构化 approval_required（含 approval_id），宿主 kiwi_approve 后携 id 重试。",
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
            agreement_id: String(args.agreement_id),
            approval_id: args.approval_id === undefined ? undefined : String(args.approval_id),
            destination_type: String(args.destination_type),
            url: args.url === undefined ? undefined : String(args.url),
          });
          return ok(JSON.stringify(result));
        } catch (error) {
          return approvalRequiredOrErr(error, {
            agreement_id: String(args.agreement_id),
            destination_type: String(args.destination_type),
          });
        }
      },
    },
    {
      name: "kiwi_approve",
      description:
        "批准一个持久审批（ASK 门）。宿主在向用户呈现非绑定协议/交接摘要并获得确认后调用；随后携 approval_id 重试 kiwi_accept_agreement / kiwi_handoff。写操作，受宿主审批系统二次拦截。",
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
                approval_id: String(args.approval_id),
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
        "拒绝一个持久审批（deny 优先路径）。拒绝后同一 approval_id 无法再批准或形成协议/交接。",
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
                approval_id: String(args.approval_id),
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
        "显式关注一个商家（拉取式订阅）。仅买家主动调用：搜索、浏览、查看资料或发起询价都不构成订阅，不得因这些行为代替买家关注。关注后买家可用 kiwi_get_follow_updates 主动查看该商家的公开动态；商家无法向关注者推送消息。需要 Kiwi 目录登录态（未配置时返回登录引导）。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["merchant_id"],
        properties: {
          merchant_id: { type: "string", minLength: 1 },
          category: { type: "string", description: "可选：只关心该类目的公开动态" },
          consent_version: { type: "string", description: "可选：买家同意的订阅条款版本" },
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
        "取消关注一个商家（幂等）。仅买家主动调用；取消后该商家不再出现在关注列表，也不再展示其公开动态更新。",
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
        "列出买家当前活跃关注的商家（关注管理面）。只读；需要 Kiwi 目录登录态（未配置时返回登录引导）。",
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
        "查看买家关注的商家有什么公开更新。仅响应买家主动询问（如“我关注的商家有什么新动态”）时调用：按水位增量返回商家公开动态（product_added / product_updated / faq_updated / service_notice / publication_withdrawn，仅公开字段），返回后水位推进、不丢不重。拉取式订阅：商家无法向买家推送消息，本工具也不代表买家接收任何商家私信。",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async handle() {
        try {
          return ok(JSON.stringify(await service.getFollowUpdates()));
        } catch (error) {
          return err(error);
        }
      },
    },
  ];
  return tools.map(({ raw: _raw, ...t }) => t);
}
