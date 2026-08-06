/**
 * LegacyNegotiationAdapter — shopping.negotiation/0.1 ↔ KNP/1.0 双向转译
 * （基线 §35 Legacy Migration / 子规范 §32 / 基线 §36 不变量 22）。
 *
 * 转译规则：
 *   lossless → translate
 *   lossy → fail closed
 *   unsupported → human/fallback
 *
 * 每一条路径都返回结构化 TranslationResult；所有「补默认值 / 丢弃字段 /
 * legacy-extension / identity」都逐条记录在 notes 里，调用方可见，绝不静默。
 *
 * 权限不扩大（不变量 22）：本适配器是纯数据转译，不执行 side effect；
 * 不把 legacy 消息提升为 KNP 更高权限语义 —— legacy 无 ConditionalOffer，
 * 本适配器从不伪造 conditions；legacy accept 只映射为 KNP accept_nonbinding
 * （非绑定），永不生成带订单/支付/库存副作用的 agreement artifact。
 *
 * 放置：src/protocol/legacy-shopping-negotiation/（基线 §38 推荐结构：
 * protocol/legacy-shopping-negotiation 与 kiwi-negotiation 分居）。
 */

import { validateAgainst } from "../../contracts/schemas.js";
import { contentDigest } from "../../negotiation/jcs.js";
import {
  finalizeEnvelope,
  validateEnvelope,
  verifyEnvelopeDigest,
} from "../../negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../../negotiation/domain/envelope.js";
import type { TermSet } from "../../negotiation/domain/common.js";
import type {
  AcceptedNonbindingAgreement,
  NegotiationAction,
  NegotiationPayload,
} from "../../negotiation/domain/objects.js";
import {
  PROTOCOL_VERSION,
  type NegotiationDecision,
  type PolicyResult,
  type Proposal,
  type SnapshotMessage,
} from "../../negotiation/types.js";
import {
  KNP_TO_LEGACY_ACTION,
  LEGACY_TO_KNP_ACTION,
  decisionContentSeed,
  deterministicId,
  knpMessageIdToLegacy,
  legacyMessageIdToKnp,
  offerIdOfLegacyMessage,
  proposalToTerms,
  termsToProposal,
} from "./mapping.js";
import { currencyExponent } from "./money.js";
import type {
  LegacyMessageContext,
  LegacyToKnpContext,
  TranslationNote,
  TranslationResult,
} from "./types.js";
import { failClosed, requiresHuman, translated } from "./types.js";

export type { TranslationResult, TranslationNote } from "./types.js";

const note = (kind: TranslationNote["kind"], path: string, detail: string): TranslationNote => ({
  kind,
  path,
  detail,
});

/** KNP/1.0 不允许的 legacy 消息额外字段（frozen contract additionalProperties: false）。 */
const SNAPSHOT_MESSAGE_KEYS = new Set([
  "id",
  "sender_role",
  "created_at",
  "action",
  "public_message",
  "proposal",
]);

const LEGACY_DECISION_ACTIONS = ["ask", "propose", "counter", "accept_nonbinding", "decline", "escalate"];

function defaultNow(): string {
  return new Date().toISOString();
}

function isRfc3339(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
}

function assertLegacyMessageShape(value: Record<string, unknown>): string | null {
  for (const key of Object.keys(value)) {
    if (!SNAPSHOT_MESSAGE_KEYS.has(key)) {
      return `unknown field "${key}": legacy snapshot message is frozen and closes additionalProperties`;
    }
  }
  if (typeof value.id !== "number" || !Number.isInteger(value.id) || value.id < 1) {
    return "id must be a positive integer";
  }
  if (value.sender_role !== "buyer" && value.sender_role !== "merchant") {
    return "sender_role must be buyer|merchant";
  }
  if (typeof value.created_at !== "string" || !isRfc3339(value.created_at)) {
    return "created_at must be an RFC 3339 string";
  }
  if (typeof value.public_message !== "string") {
    return "public_message must be a string";
  }
  if (value.action !== undefined && value.action !== null) {
    if (typeof value.action !== "string" || !LEGACY_DECISION_ACTIONS.includes(value.action)) {
      return `action must be one of ${LEGACY_DECISION_ACTIONS.join("|")}`;
    }
  }
  return null;
}

/**
 * shopping.negotiation/0.1 ↔ KNP/1.0 适配器。
 *
 * 纯数据转换：任何路径都不执行写入/发送；调用方负责把结果交给对应通道。
 */
export class LegacyNegotiationAdapter {
  constructor(
    private readonly opts: {
      now?: () => string;
      currencyExponentOf?: (currency: string) => number;
    } = {},
  ) {}

  private now(): string {
    return this.opts.now === undefined ? defaultNow() : this.opts.now();
  }

  private exponentOf(currency: string): number {
    return this.opts.currencyExponentOf === undefined
      ? currencyExponent(currency)
      : this.opts.currencyExponentOf(currency);
  }

  // -------------------------------------------------------------------------
  // legacy decision → KNP envelope（§35 legacy→KNP 方向）
  // -------------------------------------------------------------------------

  legacyDecisionToEnvelope(
    decision: NegotiationDecision,
    ctx: LegacyToKnpContext,
  ): TranslationResult<NegotiationEnvelope> {
    const validation = validateAgainst("decision", decision);
    if (validation.length > 0) {
      return failClosed(`legacy decision failed shopping.negotiation/0.1 schema: ${validation.join("; ")}`);
    }
    if (decision.request_human_review) {
      return requiresHuman(
        "decision.request_human_review=true routes the legacy decision to human review; KNP/1.0 has no wire-level equivalent — do not translate a human-flagged decision into an auto-processable KNP action",
      );
    }
    const mappedAction = LEGACY_TO_KNP_ACTION[decision.action];
    if (mappedAction === "requires_human") {
      return requiresHuman(
        `legacy action "${decision.action}" has no KNP/1.0 equivalent (KNP has no escalate); route to human`,
      );
    }
    const action = mappedAction;

    const notes: TranslationNote[] = [
      note("mapped", "decision.conversation_id", "mapped to envelope.negotiation_id (opaque string)"),
    ];
    if (
      decision.proposal !== undefined &&
      action !== "offer" &&
      action !== "counter_offer"
    ) {
      notes.push(
        note(
          "dropped",
          "decision.proposal",
          `legacy action "${decision.action}" is not offer-like; the attached proposal is not translated (KNP ${action} payload has no terms)`,
        ),
      );
    }
    if (decision.in_reply_to_message_id >= 1) {
      notes.push(
        note(
          "identity",
          "decision.in_reply_to_message_id",
          `encoded to envelope.in_reply_to "${legacyMessageIdToKnp(decision.in_reply_to_message_id)}" (reversible)`,
        ),
      );
    }

    const publicMessage = mergeOpenIssues(decision.public_message, decision.open_issues);
    const payloadResult = this.buildDecisionPayload(decision, action, ctx, notes, publicMessage);
    if (!payloadResult.ok) {
      return payloadResult.error;
    }

    const seed = decisionContentSeed(
      decision.conversation_id,
      action,
      decision.in_reply_to_message_id,
      payloadResult.termsForId,
      publicMessage,
    );
    notes.push(
      note(
        "default",
        "envelope.exchange_id",
        `generated deterministically (${deterministicId("ex", seed)}); legacy carries no exchange id`,
      ),
      note(
        "default",
        "envelope.message_id",
        `generated deterministically (${deterministicId("msg", seed)}); stable across retries of the same decision`,
      ),
      note("default", "envelope.created_at", "legacy decision carries no created_at; filled from adapter clock"),
    );
    if (decision.open_issues.length > 0) {
      notes.push(
        note(
          "extension",
          "decision.open_issues",
          "open_issues preserved as envelope.public_message text (KNP/1.0 has no open-issue list); the array shape is not recovered on the way back",
        ),
      );
    }
    if (decision.confidence !== undefined) {
      notes.push(
        note("dropped", "decision.confidence", "confidence is an internal model signal; KNP/1.0 has no field for it"),
      );
    }
    if (decision.reason_codes.length > 0) {
      notes.push(
        note("dropped", "decision.reason_codes", "reason_codes are internal policy codes; KNP/1.0 has no field for them"),
      );
    }

    const envelope = finalizeEnvelope({
      capability: ctx.capability,
      protocol_version: "1.0",
      negotiation_id: decision.conversation_id,
      exchange_id: deterministicId("ex", seed),
      message_id: deterministicId("msg", seed),
      in_reply_to:
        decision.in_reply_to_message_id >= 1
          ? legacyMessageIdToKnp(decision.in_reply_to_message_id)
          : undefined,
      actor: ctx.actor,
      action,
      created_at: ctx.created_at ?? this.now(),
      payload: payloadResult.payload,
      public_message: publicMessage,
    });
    return translated(envelope, notes);
  }

  private buildDecisionPayload(
    decision: NegotiationDecision,
    action: NegotiationAction,
    ctx: LegacyToKnpContext,
    notes: TranslationNote[],
    publicMessage: string,
  ):
    | { ok: true; payload: NegotiationPayload; termsForId: TermSet | undefined }
    | { ok: false; error: TranslationResult<never> } {
    switch (action) {
      case "inquiry": {
        const payload: NegotiationPayload = {
          type: "inquiry",
          subject: ctx.current_sku === undefined ? undefined : { sku: ctx.current_sku },
          questions: [],
        };
        return { ok: true, payload, termsForId: undefined };
      }
      case "offer":
      case "counter_offer": {
        if (decision.proposal === undefined) {
          return {
            ok: false,
            error: failClosed(
              `legacy action "${decision.action}" requires a proposal; decision carries none`,
            ),
          };
        }
        const converted = proposalToTerms(decision.proposal, (c) => this.exponentOf(c));
        if (!converted.ok) {
          return { ok: false, error: failClosed(converted.reason) };
        }
        notes.push(...converted.notes);
        const terms = converted.value;
        const offerId = deterministicId(
          "off",
          decisionContentSeed(
            decision.conversation_id,
            action,
            decision.in_reply_to_message_id,
            terms,
            publicMessage,
          ),
        );
        notes.push(
          note(
            "default",
            "payload.offer_id",
            `generated deterministically from decision content (${offerId}); legacy decision has no offer_id before the gateway assigns a message id`,
          ),
        );
        if (action === "counter_offer") {
          const respondingTo = offerIdOfLegacyMessage(decision.in_reply_to_message_id);
          notes.push(
            note(
              "identity",
              "payload.responding_to_offer_id",
              `derived from in_reply_to_message_id (${respondingTo}); the message being countered is the offer carrier`,
            ),
          );
          const payload: NegotiationPayload = {
            type: "counter_offer",
            offer_id: offerId,
            responding_to_offer_id: respondingTo,
            proposed_terms: terms,
          };
          return { ok: true, payload, termsForId: terms };
        }
        const payload: NegotiationPayload = { type: "offer", offer_id: offerId, terms };
        return { ok: true, payload, termsForId: terms };
      }
      case "accept_nonbinding": {
        const acceptedTerms = ctx.resolveAcceptedTerms?.(
          decision.conversation_id,
          decision.in_reply_to_message_id,
        );
        if (acceptedTerms === undefined || acceptedTerms === null) {
          return {
            ok: false,
            error: failClosed(
              "legacy accept_nonbinding cannot be translated: the accepted offer terms are required to compute terms_digest (§15); provide ctx.resolveAcceptedTerms",
            ),
          };
        }
        const offerId = offerIdOfLegacyMessage(decision.in_reply_to_message_id);
        notes.push(
          note("identity", "payload.offer_id", `derived from in_reply_to_message_id (${offerId})`),
          note(
            "identity",
            "payload.terms_digest",
            "computed from resolved accepted offer terms (§19.3); legacy accept does not carry the accepted terms",
          ),
        );
        const payload: NegotiationPayload = {
          type: "accept_nonbinding",
          offer_id: offerId,
          terms_digest: contentDigest(acceptedTerms),
        };
        return { ok: true, payload, termsForId: acceptedTerms };
      }
      case "decline": {
        const targetMessageId = legacyMessageIdToKnp(decision.in_reply_to_message_id);
        const targetOfferId = offerIdOfLegacyMessage(decision.in_reply_to_message_id);
        notes.push(
          note("identity", "payload.target_message_id", `encoded from in_reply_to_message_id (${targetMessageId})`),
          note("identity", "payload.target_offer_id", `derived from in_reply_to_message_id (${targetOfferId})`),
          note(
            "default",
            "payload.scope",
            'legacy decline is offer-scoped (declines the current proposal, negotiation stays open); defaulted to scope="offer"',
          ),
        );
        const payload: NegotiationPayload = {
          type: "decline",
          target_message_id: targetMessageId,
          target_offer_id: targetOfferId,
          scope: "offer",
        };
        return { ok: true, payload, termsForId: undefined };
      }
      default:
        return {
          ok: false,
          error: failClosed(`legacy action "${decision.action}" maps to unsupported KNP action ${action}`),
        };
    }
  }

  // -------------------------------------------------------------------------
  // KNP envelope → legacy decision（§35 KNP→legacy 方向）
  // -------------------------------------------------------------------------

  envelopeToLegacyDecision(envelope: NegotiationEnvelope): TranslationResult<NegotiationDecision> {
    const validated = this.validateKnpEnvelope(envelope);
    if (!validated.ok) return validated.error;

    const mapped = KNP_TO_LEGACY_ACTION[envelope.action];
    if (mapped === "fail_closed") {
      return failClosed(
        `KNP action "${envelope.action}" cannot be expressed in shopping.negotiation/0.1: ${failClosedReason(envelope.action)} (protected semantics must not be silently dropped)`,
      );
    }
    if (mapped === "requires_human") {
      return requiresHuman(
        `KNP action "${envelope.action}" is unsupported by shopping.negotiation/0.1; route to human`,
      );
    }

    const notes: TranslationNote[] = [
      note(
        "identity",
        "envelope.actor",
        `actor="${envelope.actor}" MUST be asserted by the legacy transport (token-bound); shopping.negotiation/0.1 decisions carry no role field`,
      ),
      note("dropped", "envelope.message_id", "KNP message_id is a string; legacy decisions carry no message id"),
      note("dropped", "envelope.exchange_id", "legacy decisions carry no exchange id"),
      note("dropped", "envelope.digest", "digest is verified by the adapter; the value itself is not expressible in legacy"),
      note("dropped", "envelope.capability", "legacy decisions carry no capability id"),
      note("dropped", "envelope.created_at", "legacy decisions carry no created_at"),
      note("default", "decision.reason_codes", "KNP/1.0 has no reason_codes; defaulted to []"),
      note("default", "decision.request_human_review", "KNP/1.0 has no human-review flag; defaulted to false"),
    ];

    let inReplyTo: number;
    if (envelope.action === "decline") {
      if (envelope.payload.type !== "decline") {
        return failClosed("KNP envelope action/payload mismatch (action=decline but payload is not a decline)");
      }
      if (envelope.payload.scope === "negotiation") {
        return failClosed(
          "KNP decline scope=negotiation is not expressible in shopping.negotiation/0.1: legacy decline is offer-scoped only",
        );
      }
      const target = knpMessageIdToLegacy(envelope.payload.target_message_id);
      if (target === null || target < 1) {
        return failClosed(
          `KNP decline target_message_id "${envelope.payload.target_message_id}" cannot be mapped to a legacy message id (identity)`,
        );
      }
      inReplyTo = target;
      notes.push(
        note("dropped", "payload.target_offer_id", "legacy decisions carry no target_offer_id"),
        note("mapped", "payload.target_message_id", `mapped to decision.in_reply_to_message_id (${inReplyTo})`),
      );
    } else {
      if (envelope.in_reply_to === undefined) {
        return failClosed(
          "legacy decision requires in_reply_to_message_id; KNP envelope has no in_reply_to",
        );
      }
      const decoded = knpMessageIdToLegacy(envelope.in_reply_to);
      if (decoded === null || decoded < 1) {
        return failClosed(
          `KNP in_reply_to "${envelope.in_reply_to}" cannot be mapped to a legacy message id (identity)`,
        );
      }
      inReplyTo = decoded;
      notes.push(note("mapped", "envelope.in_reply_to", `mapped to decision.in_reply_to_message_id (${inReplyTo})`));
    }

    // KNP 无 open-issue 列表；clarification/inquiry 的结构化 questions 以自由文本
    // 保留进 decision.open_issues（结构丢失但内容保留，记录 note —— 非静默）。
    let openIssues: string[] = [];
    if (envelope.action === "clarification" && envelope.payload.type === "clarification") {
      openIssues = envelope.payload.questions.map((q) =>
        q.reason === undefined ? q.field : `${q.field}: ${q.reason}`,
      );
      notes.push(
        note(
          "extension",
          "payload.questions",
          "clarification questions flattened to decision.open_issues free text (field/reason structure dropped)",
        ),
      );
    } else if (
      envelope.action === "inquiry" &&
      envelope.payload.type === "inquiry" &&
      (envelope.payload.questions?.length ?? 0) > 0
    ) {
      openIssues = (envelope.payload.questions ?? []).map((q) => q.code);
      notes.push(
        note(
          "extension",
          "payload.questions",
          "inquiry question codes preserved as decision.open_issues free text",
        ),
      );
    }

    let proposal: Proposal | undefined;
    if (envelope.action === "offer" || envelope.action === "counter_offer") {
      const terms = offerLikeTerms(envelope);
      if (terms === undefined) {
        return failClosed("KNP envelope action/payload mismatch for offer-like action");
      }
      const converted = termsToProposal(terms, (c) => this.exponentOf(c));
      if (!converted.ok) {
        return failClosed(converted.reason);
      }
      proposal = converted.value;
      notes.push(...converted.notes);
      notes.push(
        envelope.action === "offer"
          ? note("dropped", "payload.offer_id", "legacy proposal carries no offer_id; the gateway resolves the current proposal")
          : note("dropped", "payload.offer_id", "legacy proposal carries no offer_id"),
      );
      if (envelope.action === "counter_offer") {
        notes.push(
          note(
            "dropped",
            "payload.responding_to_offer_id",
            "legacy counter carries no responding offer reference; in_reply_to_message_id encodes the countered message",
          ),
        );
      }
    }

    if (envelope.action === "accept_nonbinding" && envelope.payload.type === "accept_nonbinding") {
      notes.push(
        note(
          "dropped",
          "payload.offer_id",
          "legacy accept decision carries no offer_id; the gateway resolves the accepted proposal",
        ),
        note(
          "dropped",
          "payload.terms_digest",
          "legacy accept decision carries no terms_digest",
        ),
      );
    }
    if (openIssues.length === 0) {
      notes.push(note("default", "decision.open_issues", "KNP/1.0 has no open-issue list; defaulted to []"));
    }
    const decision: NegotiationDecision = {
      protocol_version: PROTOCOL_VERSION,
      conversation_id: envelope.negotiation_id,
      in_reply_to_message_id: inReplyTo,
      action: mapped,
      ...(proposal === undefined ? {} : { proposal }),
      open_issues: openIssues,
      public_message: envelope.public_message ?? "",
      reason_codes: [],
      request_human_review: false,
    };
    if (envelope.public_message === undefined) {
      notes.push(note("default", "envelope.public_message", 'KNP public_message is optional; defaulted to ""'));
    }
    return translated(decision, notes);
  }

  // -------------------------------------------------------------------------
  // legacy snapshot message ↔ KNP envelope
  // -------------------------------------------------------------------------

  legacyMessageToEnvelope(
    message: SnapshotMessage,
    ctx: LegacyMessageContext,
  ): TranslationResult<NegotiationEnvelope> {
    const shapeError = assertLegacyMessageShape(message as unknown as Record<string, unknown>);
    if (shapeError !== null) {
      return failClosed(`legacy snapshot message failed shopping.negotiation/0.1 shape: ${shapeError}`);
    }
    if (message.action === undefined) {
      return failClosed("legacy snapshot message has no action; cannot translate to a KNP action");
    }
    if (message.action === "escalate") {
      return requiresHuman(
        'legacy message action "escalate" has no KNP/1.0 equivalent; route to human',
      );
    }
    const action = LEGACY_TO_KNP_ACTION[message.action];
    if (action === "requires_human") {
      return requiresHuman(`legacy message action "${message.action}" has no KNP/1.0 equivalent`);
    }

    const notes: TranslationNote[] = [
      note(
        "identity",
        "message.id",
        `encoded to envelope.message_id "${legacyMessageIdToKnp(message.id)}" (reversible)`,
      ),
      note("mapped", "message.sender_role", `mapped to envelope.actor (${message.sender_role})`),
    ];
    if (message.proposal !== undefined && message.proposal !== null && action !== "offer" && action !== "counter_offer") {
      notes.push(
        note(
          "dropped",
          "message.proposal",
          `legacy message action "${message.action}" is not offer-like; the attached proposal is not translated`,
        ),
      );
    }

    let payload: NegotiationPayload;
    let termsForId: TermSet | undefined;
    if (action === "offer" || action === "counter_offer") {
      if (message.proposal === undefined || message.proposal === null) {
        return failClosed(
          `legacy message action "${message.action}" requires a proposal; message carries none`,
        );
      }
      const converted = proposalToTerms(message.proposal, (c) => this.exponentOf(c));
      if (!converted.ok) return failClosed(converted.reason);
      notes.push(...converted.notes);
      termsForId = converted.value;
      const offerId = offerIdOfLegacyMessage(message.id);
      notes.push(
        note("identity", "payload.offer_id", `derived from message.id (${offerId}) — the offer this message carries`),
      );
      if (action === "offer") {
        payload = { type: "offer", offer_id: offerId, terms: converted.value };
      } else {
        const target = this.legacyReplyTarget(ctx);
        if (target === null) {
          return failClosed(
            "legacy counter message cannot be translated: its countered offer reference is unknown without ctx.in_reply_to",
          );
        }
        payload = {
          type: "counter_offer",
          offer_id: offerId,
          responding_to_offer_id: offerIdOfLegacyMessage(target),
          proposed_terms: converted.value,
        };
      }
    } else if (action === "inquiry") {
      payload = {
        type: "inquiry",
        subject: ctx.current_sku === undefined ? undefined : { sku: ctx.current_sku },
        questions: [],
      };
    } else if (action === "decline") {
      const target = this.legacyReplyTarget(ctx);
      if (target === null) {
        return failClosed(
          "legacy decline message cannot be translated: its target message is unknown without ctx.in_reply_to",
        );
      }
      payload = {
        type: "decline",
        target_message_id: legacyMessageIdToKnp(target),
        target_offer_id: offerIdOfLegacyMessage(target),
        scope: "offer",
      };
      notes.push(
        note("identity", "payload.target_message_id", `target derived from ctx.in_reply_to (msg_legacy_${target})`),
        note("default", "payload.scope", 'legacy decline is offer-scoped; defaulted to scope="offer"'),
      );
    } else {
      // accept_nonbinding message
      const acceptedTerms = ctx.resolveAcceptedTerms?.(ctx.conversation_id, message.id);
      if (acceptedTerms === undefined || acceptedTerms === null) {
        return failClosed(
          "legacy accept_nonbinding message cannot be translated: the accepted offer terms are required for terms_digest (§15); provide ctx.resolveAcceptedTerms",
        );
      }
      const target = this.legacyReplyTarget(ctx);
      if (target === null) {
        return failClosed(
          "legacy accept_nonbinding message cannot be translated: the accepted offer reference is unknown without ctx.in_reply_to",
        );
      }
      payload = {
        type: "accept_nonbinding",
        offer_id: offerIdOfLegacyMessage(target),
        terms_digest: contentDigest(acceptedTerms),
      };
      notes.push(
        note("identity", "payload.offer_id", `accepted offer derived from ctx.in_reply_to (off_legacy_${target})`),
        note("identity", "payload.terms_digest", "computed from resolved accepted offer terms (§19.3)"),
      );
    }

    const seed = decisionContentSeed(
      ctx.conversation_id,
      action,
      message.id,
      termsForId,
      message.public_message,
    );
    const envelope = finalizeEnvelope({
      capability: ctx.capability,
      protocol_version: "1.0",
      negotiation_id: ctx.conversation_id,
      exchange_id: deterministicId("ex", seed),
      message_id: legacyMessageIdToKnp(message.id),
      in_reply_to: ctx.in_reply_to,
      actor: message.sender_role,
      action,
      created_at: message.created_at,
      payload,
      public_message: message.public_message,
    });
    return translated(envelope, notes);
  }

  envelopeToLegacyMessage(envelope: NegotiationEnvelope): TranslationResult<SnapshotMessage> {
    const validated = this.validateKnpEnvelope(envelope);
    if (!validated.ok) return validated.error;

    const id = knpMessageIdToLegacy(envelope.message_id);
    if (id === null || id < 1) {
      return failClosed(
        `KNP message_id "${envelope.message_id}" cannot be mapped to a legacy message id (identity)`,
      );
    }
    const mapped = KNP_TO_LEGACY_ACTION[envelope.action];
    if (mapped === "fail_closed") {
      return failClosed(
        `KNP action "${envelope.action}" cannot be expressed as a shopping.negotiation/0.1 message: ${failClosedReason(envelope.action)}`,
      );
    }
    if (mapped === "requires_human") {
      return requiresHuman(
        `KNP action "${envelope.action}" is unsupported by shopping.negotiation/0.1; route to human`,
      );
    }

    const notes: TranslationNote[] = [
      note("identity", "envelope.actor", `actor="${envelope.actor}" MUST be asserted by the legacy transport`),
      note("dropped", "envelope.digest", "digest is not expressible in a legacy snapshot message"),
      note("dropped", "envelope.exchange_id", "legacy messages carry no exchange id"),
      note("dropped", "envelope.capability", "legacy messages carry no capability id"),
    ];

    let proposal: Proposal | null = null;
    if (envelope.action === "offer" || envelope.action === "counter_offer") {
      const terms = offerLikeTerms(envelope);
      if (terms === undefined) {
        return failClosed("KNP envelope action/payload mismatch for offer-like action");
      }
      const converted = termsToProposal(terms, (c) => this.exponentOf(c));
      if (!converted.ok) return failClosed(converted.reason);
      proposal = converted.value;
      notes.push(...converted.notes);
    }
    if (
      envelope.payload.type === "clarification" &&
      envelope.payload.questions.length > 0
    ) {
      notes.push(
        note(
          "dropped",
          "payload.questions",
          "legacy snapshot messages carry no open-issue list; clarification questions are not preserved as a message (public_message carries the free text)",
        ),
      );
    }

    const message: SnapshotMessage = {
      id,
      sender_role: envelope.actor,
      created_at: envelope.created_at,
      action: mapped,
      public_message: envelope.public_message ?? "",
      proposal,
    };
    if (envelope.public_message === undefined) {
      notes.push(note("default", "envelope.public_message", 'KNP public_message is optional; defaulted to ""'));
    }
    return translated(message, notes);
  }

  // -------------------------------------------------------------------------
  // Agreement artifact → legacy（受保护：agreement 语义，恒 fail-closed）
  // -------------------------------------------------------------------------

  agreementToLegacyPolicyResult(
    agreement: AcceptedNonbindingAgreement,
  ): TranslationResult<PolicyResult> {
    return failClosed(
      `shopping.negotiation/0.1 has no agreement artifact: cannot express agreement_id=${agreement.agreement_id}, ` +
        `accepted_offer_id=${agreement.accepted_offer_id}, terms_digest, agreed_terms, accepted_by, ` +
        `binding_effect, and the creates_order/reserves_inventory/authorizes_payment=false flags ` +
        "(§35: agreement semantics must not be silently dropped; route to human)",
    );
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private validateKnpEnvelope(
    envelope: NegotiationEnvelope,
  ): { ok: true } | { ok: false; error: TranslationResult<never> } {
    try {
      validateEnvelope(envelope);
    } catch (e) {
      return {
        ok: false,
        error: failClosed(
          `KNP envelope failed validation: ${e instanceof Error ? e.message : String(e)}`,
        ),
      };
    }
    if (!verifyEnvelopeDigest(envelope)) {
      return {
        ok: false,
        error: failClosed("KNP envelope digest does not match its content (tampered or stale)"),
      };
    }
    return { ok: true };
  }

  private legacyReplyTarget(ctx: LegacyMessageContext): number | null {
    if (ctx.in_reply_to === undefined) return null;
    return knpMessageIdToLegacy(ctx.in_reply_to);
  }
}

function mergeOpenIssues(publicMessage: string, openIssues: string[]): string {
  if (openIssues.length === 0) return publicMessage;
  const issuesText = openIssues.join("; ");
  return publicMessage.length === 0 ? issuesText : `${publicMessage} | ${issuesText}`;
}

function offerLikeTerms(envelope: NegotiationEnvelope): TermSet | undefined {
  if (envelope.payload.type === "offer") return envelope.payload.terms;
  if (envelope.payload.type === "counter_offer") return envelope.payload.proposed_terms;
  return undefined;
}

function failClosedReason(action: NegotiationAction): string {
  switch (action) {
    case "conditional_offer":
      return "KNP conditional semantics (conditions) have no legacy representation";
    default:
      return `KNP action ${action} has no legacy representation`;
  }
}
