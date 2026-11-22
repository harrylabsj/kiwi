import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { contentDigest } from "../../negotiation/jcs.js";
import { McpError } from "../errors.js";
import { asRecord, basisDigest, projectRequirements, validTimestamp, type Basis } from "./requirements.js";
import { compareQuotes } from "./quote-comparison.js";
import { missingBasis, observe, sourceVersion, type Coverage, type Evidence, type ObservedProduct, type Source } from "./source-observation.js";
import type { ProcurementStore } from "./store.js";

export interface CaseRef { case_id: string; revision: number }
export interface RfqRef extends CaseRef { source_binding_id: string; replaces_source_id?: string }
export interface ProcurementAction {
  id: string;
  revision: number;
  case_id: string;
  case_revision: number;
  operation: "rfq" | "clarification" | "counter_offer";
  request_id: string;
  digest: string;
  payload: Record<string, unknown>;
  status: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED" | "IN_FLIGHT" | "UNKNOWN" | "DONE";
  expires_at: string;
  result?: Record<string, unknown>;
  round?: number;
}
interface GroupLine { input_line_id: string; raw: string; case_id?: string }
interface Group { id: string; revision: number; lines: GroupLine[] }
export interface Case {
  id: string;
  revision: number;
  state: "ACTIVE" | "CLOSED" | "CANCELLED";
  basis: Basis;
  basis_digest: string;
  sources: Source[];
  coverage: Partial<Record<"kiwi" | "ecommerce", Coverage>>;
  decisions: { comparison_id: string; comparison_revision: number; source_id: string; offer_digest: string; case_revision: number; source_kind: string; evidence: string; decision: string; at: string }[];
  lifecycle?: { reason: string; outcome?: string; delivery_ref?: string; comparison_id?: string; comparison_revision?: number };
}
export interface Comparison {
  id: string; revision: number; case_id: string; case_revision: number; basis_digest: string;
  evaluated_at: string; rules_version: 1; sources_digest: string;
  data: ReturnType<typeof compareQuotes>;
  markdown: string; csv: string;
}

type SourceDraft = {
  id: string; channel: "kiwi" | "ecommerce"; variant: string; name?: string;
  merchant_id?: string; query?: string; capture_id?: string; evidence?: Evidence;
  product?: ObservedProduct; costs?: unknown; price_kind?: "PAGE_REFERENCE" | "IMPORTED_REFERENCE";
};
interface MerchantMatch { name: string; inquiry_available?: boolean; product?: ObservedProduct }
interface ProcurementDependencies {
  now(): string;
  candidate(task: string, candidate?: string): Record<string, unknown> | undefined;
  coverage(query: string): Promise<Coverage>;
  discover(query: string, merchant: string, sku: string): Promise<{ match: MerchantMatch | undefined; coverage: Coverage }>;
  captureRoot?: string;
}

export type Prepare = { request_id: string } & (
  | { operation: "register_group"; lines: GroupLine[] }
  | { operation: "create"; basis: Basis; group_ref?: { group_id: string; revision: number; input_line_id: string } }
  | { operation: "revise"; case_id: string; expected_revision: number; basis: Basis }
  | { operation: "attach_sources"; case_id: string; expected_revision: number; sources: SourceDraft[]; ecommerce_status?: Coverage; kiwi_query?: string }
  | { operation: "record_external_decision"; case_id: string; expected_revision: number; comparison_id: string; comparison_revision: number; source_id: string; source_kind: string; evidence: string; decision: string }
  | { operation: "set_state"; case_id: string; expected_revision: number; state: Case["state"]; reason: string; outcome?: string; delivery_ref?: string; comparison_id?: string; comparison_revision?: number }
);
export type Read = { operation: "get"; case_id: string; revision?: number } | { operation: "get_group"; group_id: string } |
  { operation: "list_recent"; kind: "case" | "group"; limit?: number; offset?: number };
export type Compare = { request_id: string; case_ref: CaseRef; source_ids?: string[] } & (
  { operation: "create" } | { operation: "refresh"; comparison_id: string; expected_revision: number }
);

export function fail(message: string): never { throw new McpError("invalid_params", message); }
function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) fail(message);
  return value;
}
function checkRevision(expected: number, actual: number): void {
  if (expected !== actual) fail("REVISION_CONFLICT");
}
function csvCell(value: unknown): string {
  const string = String(value ?? "");
  return '"' + (/^[\s]*[=+\-@\t\r\n]/.test(string) ? "'" : "") + string.replaceAll('"', '""') + '"';
}
function mdCell(value: unknown): string {
  return String(value ?? "待核对").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("[", "&#91;").replaceAll("]", "&#93;").replace(/[|\r\n]/g, " ");
}
function render(caseData: Case, comparison: Pick<Comparison, "id" | "revision" | "evaluated_at" | "data">) {
  const { basis, coverage, decisions } = caseData;
  const { data } = comparison;
  const headers = ["来源 ID", "供应方", "渠道", "价格性质", "匹配", "含税完整金额（分）", "已知金额（分）", "条件试算（分）", "状态", "依据", "时效", "待核对"];
  const rows = data.rows.map(row => [row.source_id, row.supplier, row.channel, row.price_kind, row.matching,
    row.cash_total_minor, row.known_amount_minor, row.conditional_amount_minor, row.group, row.evidence.reference, row.evidence.valid_until ?? row.evidence.freshness_due_at, row.missing.join("、")]);
  const markdown = [
    "# 采购建议书",
    "",
    data.recommendation ? `当前推荐方案 ${mdCell(data.recommendation)}` : "目前没有足够依据推荐方案。",
    "",
    `事项 ${caseData.id} / v${caseData.revision} · 比选 ${comparison.id} / v${comparison.revision} · ${comparison.evaluated_at}`,
    "",
    `采购基准：${mdCell(basis.description)}，${mdCell(basis.quantity)} ${mdCell(basis.unit)}，送达 ${mdCell(basis.destination)}，期限 ${mdCell(basis.delivery_before)}。`,
    `检索覆盖：Kiwi ${coverage.kiwi ?? "not_searched"}，电商 ${coverage.ecommerce ?? "not_searched"}。`,
    `可确认独立供货主体 ${data.independent_suppliers_confirmed} 家。${data.supplier_identity_unknown ? "部分供货主体身份关系待核实。" : ""}`,
    "",
    "| " + headers.join(" | ") + " |",
    "| " + headers.map(() => "---").join(" | ") + " |",
    ...rows.map(row => "| " + row.map(mdCell).join(" | ") + " |"),
    "",
    "## 待确认与人工交接",
    "",
    ...data.requirements.map(field => `- 补充需求 ${mdCell(field)}`),
    ...data.questions.map(question => `- ${mdCell(question.source_id)} / ${mdCell(question.field)}`),
    ...decisions.map(decision => `- 外部决定（${mdCell(decision.source_kind)}）${mdCell(decision.decision)}，对应比选 ${mdCell(decision.comparison_id)} v${decision.comparison_revision}。`),
  ].join("\n");
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return { markdown, csv };
}

export class ProcurementCases {
  constructor(private readonly store: ProcurementStore, private readonly owner: string, private readonly deps: ProcurementDependencies) {}

  getCase(id: string, revision?: number): Case {
    return must(this.store.read<Case>(this.owner, "case", id, revision), "CASE_NOT_FOUND");
  }

  active(ref: CaseRef): Case {
    const current = this.getCase(ref.case_id);
    checkRevision(ref.revision, current.revision);
    if (current.state !== "ACTIVE") fail("CASE_NOT_ACTIVE");
    return current;
  }

  getComparison(id: string, revision?: number) {
    const snapshot = must(this.store.read<Comparison>(this.owner, "comparison", id, revision), "COMPARISON_NOT_FOUND");
    const caseData = this.getCase(snapshot.case_id);
    const at = this.deps.now();
    return { snapshot, freshness: { evaluated_at: at, case_revision_changed: caseData.revision !== snapshot.case_revision,
      stale_sources: snapshot.data.rows.filter(row => {
        if ([row.evidence.valid_until, row.evidence.freshness_due_at].some(due => validTimestamp(due) && Date.parse(due) <= Date.parse(at))) return true;
        const source = caseData.sources.find(entry => entry.id === row.source_id);
        return !source || row.offer_digest !== this.observeSource(source, at).digest;
      }).map(row => row.source_id) } };
  }

  read(input: Read) {
    if (input.operation === "get") {
      const caseData = this.getCase(input.case_id, input.revision);
      return { case: caseData, actions: this.actions(caseData.id), missing_requirements: missingBasis(caseData.basis),
        history: this.store.history(this.owner, "case", caseData.id), decisions: caseData.decisions.map(decision => {
          const comparison = this.getComparison(decision.comparison_id, decision.comparison_revision);
          return { ...decision, needs_review: decision.case_revision !== caseData.revision ||
            comparison.freshness.stale_sources.includes(decision.source_id) ||
            this.getComparison(decision.comparison_id).snapshot.revision !== decision.comparison_revision };
        }) };
    }
    if (input.operation === "get_group") {
      const group = must(this.store.read<Group>(this.owner, "group", input.group_id), "GROUP_NOT_FOUND");
      return { group, original_line_count: group.lines.length,
        pending_input_line_ids: group.lines.filter(line => line.case_id === undefined).map(line => line.input_line_id) };
    }
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    const rows = this.store.list<Case | Group>(this.owner, input.kind, limit, offset);
    return { items: rows.map(row => ({ id: row.id, revision: row.revision, ...("state" in row ? { state: row.state, description: row.basis.description } : { line_count: row.lines.length }) })),
      next_offset: rows.length === limit ? offset + limit : null };
  }

  replay<T>(operation: string, id: string, digest: string): T | undefined {
    const saved = this.store.request<T>(this.owner, operation, id);
    if (saved && saved.digest !== digest) throw new McpError("idempotency_conflict", "IDEMPOTENCY_CONFLICT");
    return saved?.value;
  }

  private once<T>(operation: string, id: string, input: unknown, work: () => T): T {
    const digest = contentDigest(input);
    return this.store.transaction(() => {
      const replay = this.replay<T>(operation, id, digest);
      if (replay !== undefined) return replay;
      const result = work();
      this.store.saveRequest(this.owner, operation, id, digest, result);
      return result;
    });
  }

  async prepare(input: Prepare) {
    if (input.operation === "attach_sources") {
      this.getCase(input.case_id);
      const replay = this.replay("attach_sources", input.request_id, contentDigest(input));
      if (replay !== undefined) return replay;
      const basis = this.active({ case_id: input.case_id, revision: input.expected_revision });
      if (new Set(input.sources.map(source => source.id)).size !== input.sources.length) fail("DUPLICATE_SOURCE_ID");
      if (input.kiwi_query && basis.basis.channels && !basis.basis.channels.includes("kiwi")) fail("CHANNEL_OUT_OF_SCOPE");
      const [material, kiwiStatus] = await Promise.all([
        Promise.allSettled(input.sources.map(source => this.materialize(basis, source))),
        input.kiwi_query ? this.deps.coverage(input.kiwi_query) : undefined,
      ]);
      return this.once(input.operation, input.request_id, input, () => {
        const current = this.active({ case_id: input.case_id, revision: input.expected_revision });
        const sources = new Map(current.sources.map(source => [source.id, source]));
        const coverage = { ...current.coverage, ...(kiwiStatus ? { kiwi: kiwiStatus } : {}), ...(input.ecommerce_status ? { ecommerce: input.ecommerce_status } : {}) };
        const failures: { source_id: string; reason: string }[] = [];
        for (const [index, item] of material.entries()) {
          if (item.status === "rejected") {
            const draft = input.sources[index]!;
            const reason = item.reason instanceof McpError ? item.reason.message : "SOURCE_UNAVAILABLE";
            failures.push({ source_id: draft.id, reason });
            const status = reason.split(":")[1];
            if (draft.channel === "kiwi" && (status === "error" || status === "timeout" || status === "partial")) coverage.kiwi = status;
            continue;
          }
          const { source, status } = item.value;
          const prior = sources.get(source.id);
          if (prior?.task_id || (prior && (prior.channel !== source.channel || prior.merchant_id !== source.merchant_id || prior.variant !== source.variant))) fail("SOURCE_BINDING_IMMUTABLE");
          sources.set(source.id, source);
          if (status && (coverage.kiwi === undefined || coverage.kiwi === status)) coverage.kiwi = status;
          else if (status) coverage.kiwi = "partial";
        }
        if (sources.size > 20) fail("SOURCE_LIMIT");
        return { case: this.append(current, { sources: [...sources.values()], coverage }), failures };
      });
    }
    if ("case_id" in input) this.getCase(input.case_id);
    return this.once(input.operation, input.request_id, input, () => {
      if (input.operation === "register_group") {
        if (new Set(input.lines.map(line => line.input_line_id)).size !== input.lines.length) fail("DUPLICATE_INPUT_LINE");
        const group = { id: `group-${uuidv7()}`, revision: 1, lines: input.lines };
        this.store.write(this.owner, "group", group);
        return { group };
      }
      if (input.operation === "create") {
        this.validateBasis(input.basis);
        const groupRef = input.group_ref;
        const group = groupRef && must(this.store.read<Group>(this.owner, "group", groupRef.group_id), "GROUP_NOT_FOUND");
        const line = group && must(group.lines.find(value => value.input_line_id === groupRef.input_line_id), "INPUT_LINE_NOT_FOUND");
        if (line?.case_id) return { case: this.getCase(line.case_id), group };
        if (group && groupRef) checkRevision(groupRef.revision, group.revision);
        const caseData: Case = { id: `case-${uuidv7()}`, revision: 1, state: "ACTIVE",
          basis: input.basis, basis_digest: basisDigest(input.basis), sources: [], coverage: {}, decisions: [] };
        this.store.write(this.owner, "case", caseData);
        if (group && line) {
          line.case_id = caseData.id;
          group.revision++;
          this.store.write(this.owner, "group", group);
        }
        return { case: caseData, group, missing_requirements: missingBasis(caseData.basis) };
      }
      const current = this.getCase(input.case_id);
      checkRevision(input.expected_revision, current.revision);
      if (input.operation === "set_state") {
        if (current.state === input.state || (current.state !== "ACTIVE" && input.state !== "ACTIVE")) fail("INVALID_CASE_TRANSITION");
        if (input.state === "CLOSED" && (!input.outcome || !input.delivery_ref)) fail("CLOSURE_EVIDENCE_REQUIRED");
        if (input.comparison_id) {
          const { snapshot } = this.getComparison(input.comparison_id, input.comparison_revision);
          if (snapshot.case_id !== current.id || snapshot.case_revision !== current.revision) fail("COMPARISON_REVISION_CONFLICT");
        }
        for (const action of this.actions(current.id)) {
          if (action.status === "PENDING" || action.status === "APPROVED") this.updateAction(action, { status: "REVOKED" });
        }
        return { case: this.append(current, { state: input.state, lifecycle: { reason: input.reason, outcome: input.outcome,
          delivery_ref: input.delivery_ref, comparison_id: input.comparison_id, comparison_revision: input.comparison_revision } }) };
      }
      if (current.state !== "ACTIVE") fail("CASE_NOT_ACTIVE");
      if (input.operation === "revise") {
        this.validateBasis(input.basis);
        if (input.basis.buyer_item_key !== current.basis.buyer_item_key) fail("BUYER_ITEM_KEY_IMMUTABLE");
        return { case: this.append(current, { basis: input.basis, basis_digest: basisDigest(input.basis) }), missing_requirements: missingBasis(input.basis) };
      }
      const { snapshot, freshness } = this.getComparison(input.comparison_id, input.comparison_revision);
      const choice = must(snapshot.data.rows.find(row => row.source_id === input.source_id), "SOURCE_NOT_FOUND");
      if (snapshot.case_id !== current.id || snapshot.case_revision !== current.revision || snapshot.basis_digest !== current.basis_digest || freshness.stale_sources.includes(choice.source_id)) fail("COMPARISON_REVISION_CONFLICT");
      return { case: this.append(current, { decisions: [...current.decisions, { comparison_id: snapshot.id,
        comparison_revision: snapshot.revision, source_id: choice.source_id, offer_digest: choice.offer_digest,
        case_revision: current.revision + 1, source_kind: input.source_kind, evidence: input.evidence, decision: input.decision, at: this.deps.now() }] }) };
    });
  }

  private validateBasis(basis: Basis): void {
    if (new Set(basis.requirements.map(item => item.id)).size !== basis.requirements.length) fail("DUPLICATE_REQUIREMENT_ID");
    for (const requirement of basis.requirements) {
      if (requirement.comparison && requirement.comparison !== "eq" && typeof requirement.value !== "number") fail("NUMERIC_REQUIREMENT_REQUIRED");
      if (requirement.kind === "warranty" && (!Number.isSafeInteger(requirement.value) || Number(requirement.value) < 0)) fail("WARRANTY_REQUIRES_MONTHS");
    }
    if (basis.delivery_before && !validTimestamp(basis.delivery_before)) fail("INVALID_DELIVERY_DEADLINE");
  }

  private async materialize(current: Case, draft: SourceDraft): Promise<{ source: Source; status?: Coverage }> {
    const channel = draft.channel;
    const at = this.deps.now();
    if (current.basis.channels && !current.basis.channels.includes(channel)) fail("CHANNEL_OUT_OF_SCOPE");
    const base = { id: draft.id, channel, variant: draft.variant, basis_digest: current.basis_digest };
    if (channel === "kiwi") {
      const merchant = must(draft.merchant_id, "MERCHANT_REQUIRED");
      const { match, coverage } = await this.deps.discover(draft.query ?? current.basis.model ?? draft.variant, merchant, draft.variant);
      const found = must(match, `DISCOVERY_BINDING_NOT_FOUND:${coverage}`);
      return { status: coverage, source: sourceVersion({ ...base, name: found.name, merchant_id: merchant,
        inquiry_available: found.inquiry_available, product: found.product, price_kind: "IMPORTED_REFERENCE",
        evidence: { reference: `kiwi-directory/${merchant}/${draft.variant}`, captured_at: at } }) };
    }
    if (draft.capture_id) return { source: sourceVersion({ ...base, ...this.readCapture(draft.capture_id, draft.variant) }) };
    const evidence = must(draft.evidence, "EXTERNAL_EVIDENCE_REQUIRED");
    if (!validTimestamp(evidence.captured_at) || Date.parse(evidence.captured_at) > Date.parse(at) ||
        (evidence.freshness_due_at && !validTimestamp(evidence.freshness_due_at))) fail("INVALID_EVIDENCE_TIMESTAMP");
    const { supplier_ref: _unverified, verified_kiwi_merchant_id: _unverifiedLink, ...product } = draft.product ?? {};
    return { source: sourceVersion({ ...base, name: draft.name ?? draft.variant, product, evidence,
      costs: draft.costs, price_kind: draft.price_kind ?? "IMPORTED_REFERENCE" }) };
  }

  private readCapture(id: string, variant: string): Pick<Source, "name" | "price_kind" | "evidence" | "product" | "costs"> {
    const root = this.deps.captureRoot;
    if (!root || !isAbsolute(root) || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) fail("TRUSTED_CAPTURE_UNAVAILABLE");
    const directory = lstatSync(root);
    if (!directory.isDirectory() || realpathSync(root) !== root || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) fail("TRUSTED_CAPTURE_UNAVAILABLE");
    const file = join(root, id + ".json");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let values: Record<string, unknown>;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== directory.uid || (stat.mode & 0o077) !== 0 || stat.size > 262144) fail("INVALID_CAPTURE_FILE");
      values = asRecord(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
    const evidence = asRecord(values.evidence) as unknown as Evidence;
    if (values.variant !== variant || typeof values.name !== "string" || typeof evidence.reference !== "string" ||
        !validTimestamp(evidence.captured_at) || Date.parse(evidence.captured_at) > Date.parse(this.deps.now()) ||
        (evidence.valid_until !== undefined && !validTimestamp(evidence.valid_until)) ||
        (evidence.freshness_due_at !== undefined && !validTimestamp(evidence.freshness_due_at)) ||
        !["SUPPLIER_QUOTE", "CHECKOUT_SNAPSHOT", "PAGE_REFERENCE"].includes(String(values.price_kind))) fail("INVALID_CAPTURE");
    return { name: values.name, price_kind: values.price_kind as Source["price_kind"], evidence,
      product: asRecord(values.product) as ObservedProduct, costs: values.costs };
  }

  actions(caseId: string): ProcurementAction[] {
    return this.store.actions<ProcurementAction>(this.owner, caseId);
  }

  assertDispatchable(id: string): void {
    const action = this.getAction(id);
    if (action.status !== "IN_FLIGHT") fail("PROCUREMENT_ACTION_NOT_DISPATCHABLE");
    this.active({ case_id: action.case_id, revision: action.case_revision });
    if (Date.parse(action.expires_at) <= Date.parse(this.deps.now())) fail("PROCUREMENT_APPROVAL_EXPIRED");
  }

  setActionRound(id: string, round: number): void {
    this.store.transaction(() => {
      const action = this.getAction(id);
      if (action.status !== "IN_FLIGHT" || action.round !== undefined) fail("PROCUREMENT_ACTION_ALREADY_DISPATCHED");
      this.active({ case_id: action.case_id, revision: action.case_revision });
      this.updateAction(action, { round });
    });
  }

  getAction(id: string): ProcurementAction {
    return must(this.store.read<ProcurementAction>(this.owner, "action", id), "PROCUREMENT_APPROVAL_NOT_FOUND");
  }

  decideAction(id: string, approve: boolean) {
    return this.store.transaction(() => {
      const action = this.getAction(id);
      if (action.status !== "PENDING") fail("PROCUREMENT_APPROVAL_ALREADY_DECIDED");
      if (approve) {
        this.active({ case_id: action.case_id, revision: action.case_revision });
        if (Date.parse(action.expires_at) <= Date.parse(this.deps.now())) fail("PROCUREMENT_APPROVAL_EXPIRED");
      }
      return this.updateAction(action, { status: approve ? "APPROVED" : "REJECTED" });
    });
  }

  private updateAction(action: ProcurementAction, patch: Partial<ProcurementAction>) {
    const result = { ...action, ...patch, revision: action.revision + 1 };
    this.store.write(this.owner, "action", result);
    return result;
  }

  bindAction(args: {
    case_ref: CaseRef; operation: ProcurementAction["operation"]; request_id: string;
    payload: Record<string, unknown>; approval_id?: string; auto?: boolean;
    rfqTaskMissing?: () => boolean;
    validate(current: Case, resumingId?: string): void;
  }): { action: ProcurementAction; dispatch: boolean } {
    this.getCase(args.case_ref.case_id);
    const digest = contentDigest(args.payload);
    return this.store.transaction(() => {
      const id = this.replay<string>(args.operation, args.request_id, digest);
      let action = id === undefined ? undefined : this.getAction(id);
      if (action && (action.status === "DONE" || action.status === "IN_FLIGHT" || action.status === "UNKNOWN")) {
        if (action.status === "DONE" || !args.rfqTaskMissing?.()) return { action, dispatch: false };
        // No native reservation means this RFQ could not have been sent. The
        // unique native task key still arbitrates concurrent callers after commit.
        const current = this.getCase(action.case_id);
        const authorizationExpired = Date.parse(action.expires_at) <= Date.parse(this.deps.now());
        // An automatic action has no human decision. Its exposed action ID
        // cannot authorize a retry after delegation changes to "ask".
        const needsNewApproval = !args.auto && this.store.read<ProcurementAction>(this.owner, "action", action.id, 1)?.status !== "PENDING";
        // A retry also requires an unexpired authorization and the same active case revision.
        if (authorizationExpired || needsNewApproval || current.state !== "ACTIVE" || current.revision !== action.case_revision) {
          return { action: this.updateAction(action, { status: "REVOKED" }), dispatch: false };
        }
        if ((args.approval_id !== undefined || !args.auto) && args.approval_id !== action.id) fail("PROCUREMENT_APPROVAL_MISMATCH");
        args.validate(current, action.id);
        if (action.status === "UNKNOWN") action = this.updateAction(action, { status: "IN_FLIGHT" });
        return { action, dispatch: true };
      }
      const current = this.active(args.case_ref);
      if (action?.status === "REVOKED") fail("PROCUREMENT_APPROVAL_REVOKED");
      args.validate(current);
      if (!action) {
        if (args.approval_id) fail("PROCUREMENT_APPROVAL_MISMATCH");
        action = { id: `pc-approval-${uuidv7()}`, revision: 1, case_id: current.id, case_revision: current.revision,
          operation: args.operation, request_id: args.request_id, payload: args.payload, digest,
          status: args.auto ? "IN_FLIGHT" : "PENDING",
          expires_at: new Date(Date.parse(this.deps.now()) + 15 * 60_000).toISOString() };
        this.store.write(this.owner, "action", action);
        this.store.saveRequest(this.owner, args.operation, args.request_id, digest, action.id);
        return { action, dispatch: args.auto === true };
      }
      if (action.status === "REJECTED") fail("PROCUREMENT_APPROVAL_REJECTED");
      if (Date.parse(action.expires_at) <= Date.parse(this.deps.now())) fail("PROCUREMENT_APPROVAL_EXPIRED");
      if (args.approval_id !== undefined && args.approval_id !== action.id) fail("PROCUREMENT_APPROVAL_MISMATCH");
      if (!args.approval_id || action.status !== "APPROVED") return { action, dispatch: false };
      return { action: this.updateAction(action, { status: "IN_FLIGHT" }), dispatch: true };
    });
  }

  completeAction(id: string, status: "DONE" | "UNKNOWN", result: Record<string, unknown>, binding?: { source: Source; task_id: string; candidate_id?: string }) {
    return this.store.transaction(() => {
      const action = this.getAction(id);
      if (action.status === "DONE") return action.result;
      if (binding) {
        const current = this.getCase(action.case_id);
        const latest = current.sources.find(source => source.id === binding.source.id);
        if (!latest && current.sources.length >= 20) fail("SOURCE_LIMIT");
        const { version: _previousVersion, ...source } = binding.source;
        const newer = sourceVersion({ ...source, task_id: binding.task_id, candidate_id: binding.candidate_id });
        if (latest?.version !== newer.version) {
          const sources = latest ? current.sources.map(source => source.id === newer.id ? newer : source) : [...current.sources, newer];
          this.append(current, { sources });
        }
      }
      return this.updateAction(action, { status, result }).result;
    });
  }

  followupCount(caseId: string, key: string, operation: ProcurementAction["operation"], resumingId?: string): number {
    return this.store.countActions(this.owner, caseId, key, operation, resumingId);
  }

  append(current: Case, patch: Partial<Case>): Case {
    const next = { ...current, ...patch, id: current.id, revision: current.revision + 1 };
    this.store.write(this.owner, "case", next);
    return next;
  }

  private observeSource(source: Source, at: string, basis?: Basis) {
    const candidate = source.task_id ? this.deps.candidate(source.task_id, source.candidate_id) : undefined;
    const projection = basis && source.task_id ? projectRequirements(basis).projection_digest : undefined;
    return observe(source, candidate, at, projection, source.task_id ? "UNKNOWN" : "NOT_SENT");
  }

  compare(input: Compare) {
    this.getCase(input.case_ref.case_id);
    return this.once(input.operation === "create" ? "compare_create" : "compare_refresh", input.request_id, input, () => {
      const current = this.active(input.case_ref);
      const prior = input.operation === "refresh" ? this.getComparison(input.comparison_id).snapshot : undefined;
      if (prior && input.operation === "refresh") {
        if (prior.case_id !== current.id) fail("COMPARISON_NOT_FOUND");
        checkRevision(input.expected_revision, prior.revision);
      }
      const active = current.sources.filter(source => source.basis_digest === current.basis_digest);
      const superseded = new Set(active.map(source => source.replaces_source_id).filter(Boolean));
      const selected = input.source_ids ? input.source_ids.map(id => must(active.find(source => source.id === id), "SOURCE_NOT_FOUND")) :
        active.filter(source => !superseded.has(source.id));
      if (selected.length > 20 || new Set(selected.map(source => source.id)).size !== selected.length) fail("SOURCE_LIMIT_OR_DUPLICATION");
      const evaluatedAt = this.deps.now();
      const observations = selected.map(source => this.observeSource(source, evaluatedAt, current.basis));
      const snapshot = { id: prior?.id ?? `comparison-${uuidv7()}`, revision: (prior?.revision ?? 0) + 1,
        case_id: current.id, case_revision: current.revision, basis_digest: current.basis_digest, evaluated_at: evaluatedAt,
        rules_version: 1 as const, sources_digest: contentDigest(observations.map(value => [value.source.id, value.digest])),
        data: compareQuotes(current.basis, observations) };
      const full = { ...snapshot, ...render(current, snapshot) };
      this.store.write(this.owner, "comparison", full);
      return { snapshot: full };
    });
  }
}
