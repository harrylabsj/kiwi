import { createRequire } from "node:module";
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { KiwiBuyerService } from "../buyer-core/service.js";
import type { Compare, Prepare, Read, RfqRef } from "../buyer-core/procurement/cases.js";
import { fail } from "../buyer-core/procurement/cases.js";
import { requirementKinds } from "../buyer-core/procurement/requirements.js";
import { McpError } from "../buyer-core/errors.js";
import { tr } from "../i18n.js";
import { KIWI_SOURCING_TOOLS, type KiwiToolDefinition, type McpCallToolResult } from "./types.js";

export type BuyerToolProfile = "legacy13" | "company-procurement-v1";
export function buyerToolProfile(raw?: string): BuyerToolProfile {
  if (raw === undefined || raw === "legacy13") return "legacy13";
  if (raw === "company-procurement-v1") return raw;
  throw new Error("INVALID_BUYER_TOOL_PROFILE");
}
export const COMPANY_PROCUREMENT_TOOLS = [
  ...KIWI_SOURCING_TOOLS, "kiwi_prepare_procurement", "kiwi_get_procurement", "kiwi_compare_quotes", "kiwi_get_comparison",
] as const;

type Schema = Record<string, unknown>;
const schema2020 = { $schema: "https://json-schema.org/draft/2020-12/schema" };
const id = { type: "string", minLength: 1, maxLength: 256 };
const note = { type: "string", minLength: 1, maxLength: 2000 };
const time = { type: "string", minLength: 20, maxLength: 40 };
const integer = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
const revision = integer(1);
const choices = (...values: string[]) => ({ type: "string", enum: values });
const array = (items: Schema, maxItems: number, minItems = 0) => ({ type: "array", items, minItems, maxItems });
const object = (properties: Record<string, Schema>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});
const branch = (operation: string, fields: Record<string, Schema>, required = Object.keys(fields)) =>
  object({ operation: { const: operation }, ...fields }, ["operation", ...required]);
const union = (...oneOf: Schema[]) => ({ ...schema2020, type: "object", oneOf });
const basisValue = { anyOf: [note, integer(0), { type: "boolean" }] };
const coverage = choices("completed", "partial", "timeout", "error", "not_searched");
const costLine = object({
  id, kind: choices("goods", "freight", "fee", "discount"), scope: choices("per_unit", "order"),
  included: { type: "boolean" }, eligible: { type: "boolean" }, amount_minor: integer(0),
  tax: choices("gross", "net", "unknown"), tax_minor: integer(0), tax_bps: integer(0, 10000), rounding: choices("half_up"),
}, ["id", "kind", "scope", "amount_minor", "tax"]);
const costs = object({
  currency: choices("CNY"), mode: choices("components", "direct_total"), complete: { type: "boolean" },
  quantity: integer(1), unit: id, goods: costLine, charges: array(costLine, 32),
  total_minor: integer(0), deposit_minor: integer(0), pack_multiple: integer(1), min_quantity: integer(1), max_quantity: integer(1),
}, ["currency", "mode", "complete", "quantity", "unit"]);
const evidence = object({ reference: note, captured_at: time, location: note, freshness_due_at: time, account_scope: id }, ["reference", "captured_at"]);
const product = object({
  model: id, values: { type: "object", maxProperties: 20, additionalProperties: basisValue },
  stock_quantity: integer(0), arrived_by: time, destination: id,
});
const source = {
  oneOf: [
    object({ id, channel: { const: "kiwi" }, merchant_id: id, variant: id, query: id }, ["id", "channel", "merchant_id", "variant"]),
    object({ id, channel: { const: "ecommerce" }, variant: id, capture_id: id }, ["id", "channel", "variant", "capture_id"]),
    object({ id, channel: { const: "ecommerce" }, variant: id, name: id, evidence, costs, product,
      price_kind: choices("PAGE_REFERENCE", "IMPORTED_REFERENCE") }, ["id", "channel", "variant", "evidence"]),
  ],
};
const basis = object({
  buyer_item_key: id, description: note, selection_mode: choices("exact_item", "spec_based"), model: id,
  quantity: integer(1), unit: id, destination: id, delivery_before: time,
  budget: object({ amount_minor: integer(0), hardness: choices("hard", "soft"), scope: choices("total", "unit") }, ["amount_minor", "hardness", "scope"]),
  channels: { ...array(choices("kiwi", "ecommerce"), 2, 1), uniqueItems: true }, minimum_suppliers: integer(1, 20), company: id,
  requirements: array(object({ id, kind: choices(...requirementKinds), hardness: choices("hard", "soft"), value: basisValue, comparison: choices("eq", "min", "max"), source: note,
    disclose: { type: "boolean" } }, ["id", "kind", "hardness", "value", "source", "disclose"]), 20),
}, ["buyer_item_key", "description", "selection_mode", "requirements"]);
const caseRevision = { case_id: id, expected_revision: revision, request_id: id };
const caseRef = object({ case_id: id, revision }, ["case_id", "revision"]);
const comparisonRef = object({ comparison_id: id, revision }, ["comparison_id", "revision"]);
const sourceIds = { ...array(id, 20), uniqueItems: true };
const requestId = { request_id: id };
const actionFields = { task_id: id, candidate_id: id, expected_offer_digest: id,
  comparison_ref: comparisonRef, request_id: id, approval_id: id };
const requiredActionFields = ["task_id", "candidate_id", "expected_offer_digest", "comparison_ref", "request_id"];
const schemas = {
  prepare: union(
    branch("register_group", { ...requestId, lines: array(object({ input_line_id: id, raw: note }, ["input_line_id", "raw"]), 100, 1) }),
    branch("create", { ...requestId, basis, group_ref: object({ group_id: id, revision, input_line_id: id }, ["group_id", "revision", "input_line_id"]) }, ["request_id", "basis"]),
    branch("revise", { ...caseRevision, basis }),
    branch("attach_sources", { ...caseRevision, sources: array(source, 20), ecommerce_status: coverage, kiwi_query: id }, [...Object.keys(caseRevision), "sources"]),
    branch("record_external_decision", { ...caseRevision, comparison_id: id, comparison_revision: revision, source_id: id,
      source_kind: choices("user_statement", "approval_document", "email"), evidence: note, decision: note }),
    branch("set_state", { ...caseRevision, state: choices("ACTIVE", "CLOSED", "CANCELLED"), reason: note,
      outcome: choices("RECOMMENDATION", "NO_ELIGIBLE_OPTION", "PARTIAL_REPORT"), delivery_ref: note, comparison_id: id, comparison_revision: revision },
    [...Object.keys(caseRevision), "state", "reason"]),
  ),
  read: union(
    branch("get", { case_id: id, revision }, ["case_id"]),
    branch("get_group", { group_id: id }),
    branch("list_recent", { kind: choices("case", "group"), limit: integer(1, 50), offset: integer(0, 100000) }, ["kind"]),
  ),
  compare: union(
    branch("create", { case_ref: caseRef, ...requestId, source_ids: sourceIds }, ["case_ref", "request_id"]),
    branch("refresh", { case_ref: caseRef, ...requestId, source_ids: sourceIds, comparison_id: id, expected_revision: revision },
      ["case_ref", "request_id", "comparison_id", "expected_revision"]),
  ),
  getComparison: { ...schema2020, ...object({ comparison_id: id, revision }, ["comparison_id"]) },
  rfq: { ...schema2020, ...object({
    intent: object({ intent_id: id, intent_type: choices("inquiry", "procurement", "purchase"),
      items: array(object({ query: id, sku: id, quantity: object({ value: integer(1), unit: id }, ["value", "unit"]) }, ["query", "sku", "quantity"]), 1, 1)
    }, ["intent_id", "intent_type", "items"]),
    merchant_ids: array(id, 1, 1), idempotency_key: id, approval_id: id,
    procurement_ref: object({ case_id: id, revision, source_binding_id: id, replaces_source_id: id }, ["case_id", "revision", "source_binding_id"]),
  }, ["intent", "merchant_ids", "idempotency_key", "procurement_ref"]) },
  negotiate: { ...schema2020, type: "object", oneOf: [
    object({ ...actionFields, action: { const: "clarification" }, questions: array(object({ field: id, reason: note }, ["field"]), 20, 1) },
      [...requiredActionFields, "action", "questions"]),
    object({ ...actionFields, action: { const: "counter_offer" }, target_unit_price: object({
      currency: choices("CNY"), amount_minor: integer(1), basis: choices("net", "gross") }, ["currency", "amount_minor", "basis"]) },
      [...requiredActionFields, "action", "target_unit_price"]),
  ] },
};

function configure(name: string, description: string, inputSchema: Schema, run: (args: Record<string, unknown>) => unknown | Promise<unknown>): KiwiToolDefinition {
  const require = createRequire(import.meta.url);
  const Ajv = require("ajv/dist/2020.js") as typeof Ajv2020;
  const validate = new Ajv({ strict: false, ownProperties: true }).compile(inputSchema);
  return { name, description, inputSchema, async handle(args): Promise<McpCallToolResult> {
    try {
      if (!validate(args)) fail(`INVALID_PROCUREMENT_INPUT ${validate.errors?.[0]?.instancePath ?? ""} ${validate.errors?.[0]?.message ?? ""}`);
      const result = await run(args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
    } catch (error) {
      const message = error instanceof McpError ? `${error.code}: ${error.message}` : "internal_error: Procurement operation failed";
      return { content: [{ type: "text", text: `error ${message}` }], isError: true };
    }
  } };
}

export interface ProcurementToolOptions {
  captureRoot?: string;
  confirm?: (message: string) => Promise<boolean>;
}

export function installProcurementTools(legacy: KiwiToolDefinition[], service: KiwiBuyerService, options: ProcurementToolOptions) {
  const cases = service.companyProcurement(options.captureRoot);
  const tools = [
    configure("kiwi_prepare_procurement", tr("Create or revise a procurement case, attach evidence, or record an external decision.", "建立或修订采购事项、登记来源证据或记录外部决定。"),
      schemas.prepare, args => cases.prepare(args as unknown as Prepare)),
    configure("kiwi_get_procurement", tr("Read procurement cases, request groups and the scoped recent index.", "读取采购事项、原始清单和当前用户的近期索引。"),
      schemas.read, args => cases.read(args as unknown as Read)),
    configure("kiwi_compare_quotes", tr("Create an evidence-based quote comparison and export Markdown and CSV.", "生成或刷新有证据的正式比选，返回 Markdown 和 CSV。"),
      schemas.compare, args => cases.compare(args as unknown as Compare)),
    configure("kiwi_get_comparison", tr("Read an immutable comparison and its current freshness.", "读取不可变比选快照及当前时效。"),
      schemas.getComparison, args => cases.getComparison(String(args.comparison_id), args.revision as number | undefined)),
  ];
  const rfq = configure("kiwi_request_quotes", tr("Send a single-merchant RFQ bound to the current case and product.", "按采购事项和商家商品绑定向一家 Kiwi 商家询价。"),
    schemas.rfq, args => service.requestProcurementQuotes({
      procurement_ref: args.procurement_ref as RfqRef,
      intent: args.intent as Record<string, unknown>,
      merchant_ids: args.merchant_ids as string[],
      idempotency_key: String(args.idempotency_key),
      approval_id: args.approval_id as string | undefined,
    }));
  const negotiate = configure("kiwi_negotiate", tr("Clarify a verified Kiwi quote or propose an explicit unit price with its tax basis.", "针对明确的 Kiwi 报价澄清或发送明确含税口径的目标单价。"),
    schemas.negotiate, args => service.negotiateProcurement(args as unknown as Parameters<KiwiBuyerService["negotiateProcurement"]>[0]));
  const updated = legacy.map(tool => {
    if (tool.name === rfq.name) return rfq;
    if (tool.name === negotiate.name) return negotiate;
    if (tool.name !== "kiwi_approve" && tool.name !== "kiwi_reject") return tool;
    const approving = tool.name === "kiwi_approve";
    const approval = configure(tool.name, tool.description, tool.inputSchema, async args => {
      const id = String(args.approval_id);
      const action = cases.getAction(id);
      if (approving) {
        if (!options.confirm) fail("TRUSTED_HOST_CONFIRMATION_UNAVAILABLE");
        const confirmed = await options.confirm(`授权 Kiwi 采购外发 / Authorize Kiwi procurement action\n${action.operation}\n${JSON.stringify(action.payload)}`);
        if (!confirmed) fail("TRUSTED_HOST_CONFIRMATION_DECLINED");
      }
      return cases.decideAction(id, approving);
    });
    return { ...tool, handle: (args: Record<string, unknown>) =>
      typeof args.approval_id === "string" && args.approval_id.startsWith("pc-approval-") ? approval.handle(args) : tool.handle(args) };
  });
  return [...updated, ...tools];
}
