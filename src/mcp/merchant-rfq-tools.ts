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
 * 询报价工作台的 14 个 MCP 工具（设计 v0.1.1 §11.2；工具名与 06_host
 * tools.json 一致）。本层只做协议适配：入参校验、调用 MerchantRfqService、
 * 统一错误映射（RfqError → 带内 isError，错误不回显底价/内部 URL/堆栈）。
 *
 * 边界：
 *   - 确认类工具只消费服务端已验证的 confirmation_ref——模型自报
 *     human_confirmed 不作数（§11.2）；
 *   - record_delivery 只记操作者自述 REPORTED_SENT，必须引用操作者证据；
 *   - prepare_release / prepare_handoff 经命令日志登记候选（release_quote
 *     风险语义），批准走可信管理页——本层绝不返回确认凭证；
 *   - 模型工具面没有 approve、没有 merchant_id/principal_id 输入。
 */

import type { MerchantRfqService } from "../merchant-core/rfq/service.js";
import { RfqError } from "../merchant-core/rfq/types.js";
import type { MerchantMcpCallResult, MerchantMcpToolDefinition } from "./merchant-tools.js";

/** RFQ 工具的响应大小上限（与 merchant 工具同缺省）。 */
const RFQ_MAX_RESPONSE_CHARS = 12_000;

/** 需要工作流准备权限（merchant:write）的 RFQ 工具；其余只读（merchant:read）。 */
const RFQ_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "kiwi_merchant_rfq_ingest",
  "kiwi_merchant_rfq_revise",
  "kiwi_merchant_rfq_close",
  "kiwi_merchant_rfq_confirm_items",
  "kiwi_merchant_rfq_refresh_facts",
  "kiwi_merchant_rfq_price",
  "kiwi_merchant_rfq_prepare_release",
  "kiwi_merchant_rfq_record_delivery",
  "kiwi_merchant_rfq_prepare_handoff",
]);

/** RFQ 工具所需最小 scope（与既有 merchant 工具同一 scope 体系）。 */
export function requiredScopeForRfqTool(name: string): "merchant:read" | "merchant:write" {
  return RFQ_WRITE_TOOLS.has(name) ? "merchant:write" : "merchant:read";
}

/** RfqError code → 中文标签（错误详情绝不回显底价/内部地址/堆栈）。 */
const RFQ_ERROR_LABEL: Record<string, string> = {
  auth: "身份验证失败",
  forbidden: "权限不足",
  not_found: "未找到",
  validation: "参数或服务校验失败",
  unavailable: "暂时不可用",
  tenant_mismatch: "对象不属于当前商家",
  needs_clarification: "关键需求未确认",
  sku_ambiguous: "SKU 候选有歧义",
  source_unavailable: "事实来源缺失",
  source_conflict: "事实来源权威冲突",
  source_invalid: "来源材料无法解析",
  fact_stale: "关键事实已过期",
  pricing_invalid: "金额或条款超出计价契约",
  unsupported_term: "条款超出首版契约",
  policy_requires_review: "不符合授权价格或硬策略",
  version_conflict: "当前版本已变化",
  approval_stale: "审批候选已失效",
  idempotency_conflict: "同幂等键不同请求",
  operation_unknown: "结果尚未确定",
  case_closed: "询盘已取消或关闭",
};

function rfqErrorResult(err: unknown): MerchantMcpCallResult {
  if (err instanceof RfqError) {
    const label = RFQ_ERROR_LABEL[err.code] ?? "业务校验失败";
    return {
      content: [{ type: "text", text: `询报价操作失败（${label}）：${err.message}` }],
      isError: true,
    };
  }
  process.stderr.write(
    `[merchant rfq mcp] 工具调用底层异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  return {
    content: [
      { type: "text", text: "询报价操作失败（暂时性错误）：请稍后重试；若持续失败请查看服务端日志。" },
    ],
    isError: true,
  };
}

function okRfq(payload: Record<string, unknown>): MerchantMcpCallResult {
  const text = JSON.stringify(payload);
  if (text.length <= RFQ_MAX_RESPONSE_CHARS) {
    return { content: [{ type: "text", text }], structuredContent: payload };
  }
  return {
    content: [
      {
        type: "text",
        text:
          `${text.slice(0, Math.max(1, RFQ_MAX_RESPONSE_CHARS - 1))}…` +
          `（响应过大已截断：共 ${text.length} 字符；请缩小查询范围）`,
      },
    ],
    structuredContent: { truncated: true, total_chars: text.length },
  };
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RfqError("validation", `${name} 必须是非空字符串`);
  }
  return value;
}

function int(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RfqError("validation", `${name} 必须是正整数`);
  }
  return value;
}

/** quote_ref：{quote_id, revision}。 */
function quoteRef(value: unknown, name: string): { quote_id: string; revision: number } {
  if (value === null || typeof value !== "object") {
    throw new RfqError("validation", `${name} 必须是 {quote_id, revision} 对象`);
  }
  const ref = value as Record<string, unknown>;
  return { quote_id: str(ref.quote_id, `${name}.quote_id`), revision: int(ref.revision, `${name}.revision`) };
}

export interface MerchantRfqMcpSurface {
  rfq: MerchantRfqService;
  /** 候选登记接缝（经 MerchantCommandLog；release_quote 风险语义）。 */
  prepareReleaseCandidate(args: { releaseId: string }): Promise<string>;
  prepareHandoffCandidate(args: { handoffId: string; packetJson: string; packetDigest: string }): Promise<string>;
  /**
   * AuthContext 工厂（§11.1）：由服务端用已认证主体构造——绝不接受模型
   * 参数里的身份字段。单商家单主体实例的调用主体在装配点固定。
   */
  callContext: () => { principalId: string; actor: string; traceId: string; scopes?: string[] };
}

/** 发布类工具（rfq_release 功能开关；v0.1.1 §17.2 首版默认关闭，验收后打开）。 */
const RELEASE_GATED_TOOLS: ReadonlySet<string> = new Set([
  "kiwi_merchant_rfq_prepare_release",
  "kiwi_merchant_rfq_get_release",
  "kiwi_merchant_rfq_prepare_handoff",
]);

export function buildRfqMcpTools(
  surface: MerchantRfqMcpSurface | undefined,
  options: { releaseEnabled?: boolean } = {},
): {
  tools: MerchantMcpToolDefinition[];
  listTools: (scopes?: string[]) => MerchantMcpToolDefinition[];
  call: (name: string, args: Record<string, unknown>, scopes?: string[]) => Promise<MerchantMcpCallResult>;
} {
  const releaseEnabled = options.releaseEnabled === true;
  const unavailable = (): never => {
    throw new RfqError("unavailable", "询报价工作台未配置（rfq_core 未启用）；不可得");
  };
  const releaseGate = (): never => {
    throw new RfqError("unavailable", "发布/移交功能开关关闭（rfq_release=false，验收后打开）；不可得");
  };

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
    kiwi_merchant_rfq_ingest: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      const source = (args.source ?? {}) as Record<string, unknown>;
      const proposalEntries = Array.isArray((args.proposal as { entries?: unknown })?.entries)
        ? ((args.proposal as { entries: unknown[] }).entries as Record<string, unknown>[])
        : [];
      return await rfq.ingest(rfqContext(), {
        kind: source.kind === "csv" ? "csv" : str(source.kind, "source.kind") === "manual_text" ? "manual_text" : (source.kind as "manual_text"),
        content: str(source.content, "source.content"),
        ...(typeof source.display_name === "string" ? { displayName: source.display_name } : {}),
        ...(typeof source.external_ref === "string" ? { externalRef: source.external_ref } : {}),
        ...(proposalEntries.length > 0
          ? { proposal: { entries: proposalEntries as never } }
          : {}),
        idempotencyKey: str(args.idempotency_key, "idempotency_key"),
      }) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_get: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      return (await rfq.getCase(rfqContext(), str(args.case_id, "case_id"))) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_revise: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      const changes = Array.isArray(args.changes) ? (args.changes as Record<string, unknown>[]) : [];
      return await rfq.revise(rfqContext(), {
        caseId: str(args.case_id, "case_id"),
        expectedRevision: int(args.expected_revision, "expected_revision"),
        changes: changes as never,
        idempotencyKey: str(args.idempotency_key, "idempotency_key"),
      }) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_close: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      if (args.outcome !== "CANCELLED" && args.outcome !== "CLOSED") {
        throw new RfqError("validation", 'outcome 必须是 "CANCELLED" 或 "CLOSED"');
      }
      return await rfq.closeCase(rfqContext(), {
        caseId: str(args.case_id, "case_id"),
        expectedRevision: int(args.expected_revision, "expected_revision"),
        outcome: args.outcome,
        ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        idempotencyKey: str(args.idempotency_key, "idempotency_key"),
      }) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_match: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      await rfq.getCase(rfqContext(), str(args.case_id, "case_id")); // 归属校验
      return await rfq.searchProducts(rfqContext(), {
        query: str(args.query, "query"),
        ...(args.limit !== undefined ? { limit: int(args.limit, "limit") } : {}),
      }) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_confirm_items: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      // 只消费服务端已验证的 confirmation_ref（§11.2：模型不能自报已确认）。
      const selections = Array.isArray(args.selections) ? (args.selections as Record<string, unknown>[]) : [];
      return await rfq.readConfirmations(rfqContext(), {
        caseId: str(args.case_id, "case_id"),
        expectedRevision: int(args.expected_revision, "expected_revision"),
        selections: selections.map((s) => ({
          line_id: str(s.line_id, "selections.line_id"),
          sku: str(s.sku, "selections.sku"),
          confirmation_ref: str(s.confirmation_ref, "selections.confirmation_ref"),
        })),
      }) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_refresh_facts: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      return await rfq.refreshFacts(rfqContext(), {
        caseId: str(args.case_id, "case_id"),
        expectedRevision: int(args.expected_revision, "expected_revision"),
        idempotencyKey: str(args.idempotency_key, "idempotency_key"),
      }) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_price: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      return await rfq.price(rfqContext(), {
        caseId: str(args.case_id, "case_id"),
        expectedRevision: int(args.expected_revision, "expected_revision"),
        snapshotId: str(args.snapshot_id, "snapshot_id"),
        idempotencyKey: str(args.idempotency_key, "idempotency_key"),
      }) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_compare: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      return (await rfq.compare(
        rfqContext(),
        quoteRef(args.from_quote_ref, "from_quote_ref"),
        quoteRef(args.to_quote_ref, "to_quote_ref"),
      )) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_prepare_release: async (args) => {
      const s = surface ?? unavailable();
      const rfq = s.rfq;
      const quoteRefArg = quoteRef(args.quote_ref, "quote_ref");
      return await rfq.prepareRelease(rfqContext(), {
        caseId: str(args.case_id, "case_id"),
        quoteId: quoteRefArg.quote_id,
        revision: quoteRefArg.revision,
        ...(typeof args.recipient_ref === "string" ? { recipientRef: args.recipient_ref } : {}),
        idempotencyKey: str(args.idempotency_key, "idempotency_key"),
        prepareCandidate: s.prepareReleaseCandidate,
      }) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_get_release: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      return (await rfq.getRelease(rfqContext(), str(args.release_id, "release_id"))) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_record_delivery: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      const quoteRefArg = quoteRef(args.quote_ref, "quote_ref");
      return await rfq.recordDelivery(rfqContext(), {
        quoteId: quoteRefArg.quote_id,
        revision: quoteRefArg.revision,
        channel: str(args.channel, "channel") as "manual_wechat" | "manual_email" | "manual_other" | "integrated_channel",
        evidenceRef: str(args.evidence_ref, "evidence_ref"),
        idempotencyKey: str(args.idempotency_key, "idempotency_key"),
      }) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_prepare_handoff: async (args) => {
      const s = surface ?? unavailable();
      const rfq = s.rfq;
      const quoteRefArg = quoteRef(args.quote_ref, "quote_ref");
      return await rfq.prepareHandoff(rfqContext(), {
        quoteId: quoteRefArg.quote_id,
        revision: quoteRefArg.revision,
        targetRef: str(args.target_ref, "target_ref"),
        intentEvidenceRef: str(args.intent_evidence_ref, "intent_evidence_ref"),
        idempotencyKey: str(args.idempotency_key, "idempotency_key"),
        prepareCandidate: s.prepareHandoffCandidate,
      }) as unknown as Record<string, unknown>;
    },
    kiwi_merchant_rfq_get_job: async (args) => {
      const rfq = surface?.rfq ?? unavailable();
      return (await rfq.getJob(rfqContext(), str(args.job_id, "job_id"))) as unknown as Record<string, unknown>;
    },
  };

  /** AuthContext 由传输层验证后注入（§11.1）：principal/actor 来自已认证
   *  主体，不取模型参数。 */
  function rfqContext(): { principalId: string; actor: string; traceId: string; scopes?: string[] } {
    if (surface === undefined) {
      throw new RfqError("unavailable", "询报价工作台未配置（rfq_core 未启用）；不可得");
    }
    const ctx = surface.callContext();
    if (ctx.principalId.trim() === "" || ctx.actor.trim() === "") {
      throw new RfqError("auth", "缺少已认证主体（AuthContext 必须由传输层注入）");
    }
    return ctx;
  }

  const caseParam = { type: "string", description: "询盘 case_id" } as const;
  const revisionParam = { type: "integer", minimum: 1, description: "期望的询盘 revision（乐观锁）" } as const;
  const keyParam = { type: "string", description: "幂等键（同键同内容重放，同键不同内容拒绝）" } as const;
  const quoteRefParam = {
    type: "object",
    properties: {
      quote_id: { type: "string" },
      revision: { type: "integer", minimum: 1 },
    },
    required: ["quote_id", "revision"],
    additionalProperties: false,
  } as const;

  const tools: MerchantMcpToolDefinition[] = [
    {
      name: "kiwi_merchant_rfq_ingest",
      description:
        "导入客户询盘（粘贴文本或 RFC 4180 CSV；保存未批准询盘与字段提取建议）。关键数量/单位/SKU 保持未确认——由商家具名确认。",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["manual_text", "csv"], description: "来源类型" },
              content: { type: "string", description: "询盘原文（≤100KB；不自动拉取私人会话）" },
              display_name: { type: "string", description: "客户显示名（可选）" },
              external_ref: { type: "string", description: "外部引用（可选）" },
            },
            required: ["kind", "content"],
            additionalProperties: false,
          },
          proposal: {
            type: "object",
            description: "字段提取建议（可选；每个字段必须带原文 quote，全部保持未确认）",
            properties: {
              entries: { type: "array", items: { type: "object" } },
            },
            additionalProperties: false,
          },
          idempotency_key: keyParam,
        },
        required: ["source", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_get",
      description: "读取询盘当前需求、阻断项、报价版本与发布状态（只读）。",
      inputSchema: {
        type: "object",
        properties: { case_id: caseParam },
        required: ["case_id"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_revise",
      description:
        "修订需求（客户改了数量/地址等）：产生新 revision 并使旧报价审批失效。changes 每项必须带原文引用。",
      inputSchema: {
        type: "object",
        properties: {
          case_id: caseParam,
          expected_revision: revisionParam,
          changes: { type: "array", items: { type: "object" }, description: "字段变更（field_path/value/quote/line_id）" },
          idempotency_key: keyParam,
        },
        required: ["case_id", "expected_revision", "changes", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_close",
      description:
        "操作者显式取消或关闭询盘（终态）。未决审批候选一并失效；已导出文件与审计保留。",
      inputSchema: {
        type: "object",
        properties: {
          case_id: caseParam,
          expected_revision: revisionParam,
          outcome: { type: "string", enum: ["CANCELLED", "CLOSED"], description: "取消或正常关闭" },
          reason: { type: "string", description: "原因（可选）" },
          idempotency_key: keyParam,
        },
        required: ["case_id", "expected_revision", "outcome", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_match",
      description: "搜索商品候选（只读；不自动确认 SKU）。complete=false 表示触顶截断——不等于全库不存在。",
      inputSchema: {
        type: "object",
        properties: {
          case_id: caseParam,
          line_id: { type: "string", description: "需求行 id" },
          query: { type: "string", description: "搜索词" },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "返回上限（缺省 20）" },
          cursor: { type: "string", description: "翻页游标（可选）" },
        },
        required: ["case_id", "line_id", "query"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_confirm_items",
      description:
        "核对具名确认引用（只读核对）：selections 必须携带服务端签发的 confirmation_ref——来自管理页/CLI 表单，模型不能自报已确认。",
      inputSchema: {
        type: "object",
        properties: {
          case_id: caseParam,
          expected_revision: revisionParam,
          selections: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                line_id: { type: "string" },
                sku: { type: "string" },
                confirmation_ref: { type: "string" },
              },
              required: ["line_id", "sku", "confirmation_ref"],
              additionalProperties: false,
            },
          },
          idempotency_key: keyParam,
        },
        required: ["case_id", "expected_revision", "selections", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_refresh_facts",
      description: "建立新事实快照（价格/库存权威字段与新鲜度）。指纹变化会使旧报价审批失效。",
      inputSchema: {
        type: "object",
        properties: {
          case_id: caseParam,
          expected_revision: revisionParam,
          idempotency_key: keyParam,
        },
        required: ["case_id", "expected_revision", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_price",
      description:
        "确定性计价（Core 计算，不收模型提交的金额）：单价只来自已授权快照；产出不可变报价版本。",
      inputSchema: {
        type: "object",
        properties: {
          case_id: caseParam,
          expected_revision: revisionParam,
          snapshot_id: { type: "string", description: "事实快照 id（refresh_facts 返回）" },
          idempotency_key: keyParam,
        },
        required: ["case_id", "expected_revision", "snapshot_id", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_compare",
      description: "比较两版报价的字段级差异，并标注旧版失效原因（只读）。",
      inputSchema: {
        type: "object",
        properties: {
          from_quote_ref: quoteRefParam,
          to_quote_ref: quoteRefParam,
        },
        required: ["from_quote_ref", "to_quote_ref"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_prepare_release",
      description:
        "准备正式发布（prepare：渲染最终文件并冻结哈希，登记审批候选与预览）。批准必须由商家在可信管理页完成。",
      inputSchema: {
        type: "object",
        properties: {
          case_id: caseParam,
          quote_ref: quoteRefParam,
          recipient_ref: { type: "string", description: "收件对象（缺省用需求里已确认的收件对象）" },
          idempotency_key: keyParam,
        },
        required: ["case_id", "quote_ref", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_get_release",
      description: "查询发布/批准/导出状态与授权产物引用（只读；不含确认凭证）。",
      inputSchema: {
        type: "object",
        properties: { release_id: { type: "string", description: "发布 id" } },
        required: ["release_id"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_record_delivery",
      description:
        "记录操作者自述的发送（REPORTED_SENT）：必须引用操作者提供的证据；导出状态不冒充发送状态，证据等级不可由模型提升。",
      inputSchema: {
        type: "object",
        properties: {
          quote_ref: quoteRefParam,
          channel: { type: "string", enum: ["manual_wechat", "manual_email", "manual_other", "integrated_channel"] },
          evidence_ref: { type: "string", description: "操作者提供的证据引用（非空）" },
          idempotency_key: keyParam,
        },
        required: ["quote_ref", "channel", "evidence_ref", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_prepare_handoff",
      description:
        "准备移交包的批准（只准备，不提交目标系统）：包已生成 ≠ 目标系统已受理；批准在可信管理页完成。",
      inputSchema: {
        type: "object",
        properties: {
          quote_ref: quoteRefParam,
          target_ref: { type: "string", description: "目标系统引用" },
          intent_evidence_ref: { type: "string", description: "客户意向证据引用" },
          idempotency_key: keyParam,
        },
        required: ["quote_ref", "target_ref", "intent_evidence_ref", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "kiwi_merchant_rfq_get_job",
      description: "查询长任务作业状态（QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED/UNKNOWN；只读）。",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string", description: "作业 id" } },
        required: ["job_id"],
        additionalProperties: false,
      },
    },
  ];

  const scopeAllows = (scopes: string[] | undefined, required: string): boolean =>
    scopes === undefined ? true : scopes.includes(required);

  const call = async (
    name: string,
    args: Record<string, unknown>,
    scopes?: string[],
  ): Promise<MerchantMcpCallResult> => {
    const handler = handlers[name];
    if (handler === undefined) {
      return rfqErrorResult(new RfqError("validation", `未知工具 ${name}`));
    }
    const required = requiredScopeForRfqTool(name);
    if (!scopeAllows(scopes, required)) {
      return rfqErrorResult(
        new RfqError("auth", `scope 不足：${name} 需要 ${required}（当前授权：${(scopes ?? []).join(" ") || "无"}）`),
      );
    }
    if (!releaseEnabled && RELEASE_GATED_TOOLS.has(name)) {
      return rfqErrorResult(releaseGate());
    }
    try {
      const payload = await handler(args);
      return okRfq(payload);
    } catch (err) {
      return rfqErrorResult(err);
    }
  };

  const listTools = (scopes?: string[]): MerchantMcpToolDefinition[] =>
    tools.filter(
      (t) =>
        (releaseEnabled || !RELEASE_GATED_TOOLS.has(t.name)) &&
        scopeAllows(scopes, requiredScopeForRfqTool(t.name)),
    );

  return { tools, listTools, call };
}
