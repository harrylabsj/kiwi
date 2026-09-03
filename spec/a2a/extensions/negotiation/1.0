---
title: Kiwi Negotiation Protocol 1.0
doc_revision: "1.4"
short_name: KNP/1.0
status: Normative Specification (Released 2026-08-07; errata/editorial revision)
date: 2026-08-07
target_implementation: Kiwi v0.7.0 (draft; v0.6.0 发布身份见 CHANGELOG.md)
scope: Pre-transaction Agent-to-Agent commerce negotiation
---

# Kiwi Negotiation Protocol 1.0

**A2A v1.0 已宣布（2026-08-07）**：基线 §41 完成定义 27/27 经就绪度审计实证满足。
namespace 与 schema 托管于 `https://kiwi.harrylabsj.com`（公开仓库 `harrylabsj/kiwi-spec`）。

## 1. Status of This Specification

This document defines the normative interoperability contract for Kiwi pre-transaction commerce negotiation.

Publication of the specification and evidence of cross-vendor interoperability are separate claims. The Kiwi v1.0 reference implementation has bilateral Kiwi-side interoperability evidence; it MUST NOT be described as independently implemented or cross-vendor interoperability until such a test exists.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as described in RFC 2119 and RFC 8174.

This specification intentionally ends at a **non-binding commercial agreement**. An implementation conforming to KNP/1.0 MUST NOT treat a successful negotiation as an order, payment authorization, inventory reservation, refund instruction, or legally binding contract unless a separate downstream protocol explicitly performs that action.

KNP/1.0 is designed to run over A2A and to be advertised as a vendor commerce capability through UCP. It does not redefine A2A transport semantics or UCP standard capabilities.

---

# 2. Scope

KNP/1.0 defines:

- negotiation identifiers;
- the Kiwi negotiation envelope;
- Inquiry;
- RFQ;
- Offer;
- CounterOffer;
- ConditionalOffer;
- Clarification;
- AcceptNonbinding;
- Withdraw;
- Decline;
- AcceptedNonbindingAgreement;
- protocol errors;
- deterministic conditional-offer evaluation;
- idempotency and replay behavior;
- negotiation state transitions;
- recovery requirements;
- A2A binding requirements;
- UCP capability advertisement requirements;
- conformance test vectors.

KNP/1.0 does **not** define:

- product search ranking;
- recommendation algorithms;
- private Buyer memory;
- private Merchant pricing strategy;
- checkout;
- payment;
- order creation;
- refunds;
- inventory reservation;
- escrow;
- contract execution.

---

# 3. Relationship to Kiwi Runtime

A Kiwi implementation MAY use Embedded Pi, OpenClaw via ACP-Runtime, Hermes via ACP-Runtime, or another reasoning backend.

The reasoning backend MUST NOT alter the wire semantics defined by this specification.

A model-generated action MUST be treated as an untrusted candidate until the host runtime performs, at minimum:

1. context binding;
2. schema validation;
3. hard-policy validation;
4. disclosure-policy validation;
5. counterparty capability validation;
6. approval routing;
7. pre-send remote-state revalidation.

An approved candidate MUST become stale if its bound payload, remote revision, policy version, counterparty identity, or relevant offer validity changes before transmission.

---

# 4. Protocol Identity and Governance

## 4.1 Internal Implementation Identifier

Implementations MAY use:

```text
kiwi.negotiation/1.0
```

as an internal package or implementation-family identifier.

This string MUST NOT be used as the public governance authority of a UCP capability.

## 4.2 A2A Extension URI

A public KNP deployment MUST publish a stable HTTPS A2A extension URI controlled by the protocol authority, for example:

```text
https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0
```

The value above is illustrative only.

## 4.3 UCP Vendor Capability

A public KNP deployment MUST advertise a UCP capability whose identifier follows:

```text
{reverse-domain}.{service}.{capability}
```

For example:

```text
com.harrylabsj.kiwi.shopping.negotiation
```

The `spec` and `schema` origins MUST satisfy UCP namespace-authority rules.

## 4.4 Wire Capability Identifier

Every KNP envelope MUST contain the negotiated public capability identifier in `capability`.

The concrete production identifier MUST be frozen before public interoperability release.

Test vectors in this specification use:

```text
com.harrylabsj.kiwi.shopping.negotiation
```

only as an example authority.

---

# 5. Versioning

The protocol version defined here is:

```text
1.0
```

A sender MUST include `protocol_version`.

A receiver that does not support the declared version MUST return `protocol_version_unsupported` and MUST NOT reinterpret the payload as another version.

Breaking changes require a new protocol version.

Adding an optional field is non-breaking only when an older implementation can safely ignore it.

A KNP implementation SHOULD ignore unknown non-security-critical optional fields, but MUST reject an unknown field when the active JSON Schema marks the containing object with `additionalProperties: false`.

---

# 6. Common Identifiers

All identifiers are opaque to the counterparty unless otherwise stated.

Identifiers MUST be unique within the scope defined below.

Implementations SHOULD use UUIDv7 or another collision-resistant sortable identifier.

## 6.1 `negotiation_id`

Identifies one complete business negotiation.

- Generated by the negotiation initiator.
- Stable across process restarts.
- MAY span multiple A2A Messages.
- MAY span multiple A2A Tasks.
- MUST NOT be reused for an unrelated negotiation.

## 6.2 `exchange_id`

Identifies one semantic request/response exchange inside a negotiation.

Examples:

- RFQ → Offer
- Offer → CounterOffer
- CounterOffer → ConditionalOffer

## 6.3 `message_id`

Identifies one KNP wire message.

- Generated by the sender.
- MUST be stable across retries.
- MUST NOT be reused with different content.

## 6.4 `offer_id`

Identifies one offer-like proposal.

`Offer`, `CounterOffer`, and `ConditionalOffer` MUST each have their own `offer_id`.

A CounterOffer MUST reference the previous offer-like object with `responding_to_offer_id`.

## 6.5 `agreement_id`

Identifies one AcceptedNonbindingAgreement.

## 6.6 A2A `contextId`

A KNP runtime MUST persist the mapping:

```text
negotiation_id ↔ A2A contextId
```

when A2A returns or establishes a context.

A KNP implementation MUST treat `contextId` as opaque.

## 6.7 A2A `taskId`

A KNP negotiation MAY involve zero or more A2A Tasks.

A `taskId` is transport/session state and MUST NOT replace `negotiation_id`.

---

# 7. Common Data Types

## 7.1 Money

All monetary values MUST use minor units:

```json
{
  "currency": "CNY",
  "amount_minor": 83500
}
```

`currency` MUST be a three-letter uppercase currency code.

`amount_minor` MUST be an integer.

Floating-point monetary values MUST NOT appear in protocol payloads.

## 7.2 Quantity

```json
{
  "value": 200,
  "unit": "piece"
}
```

`value` MUST be positive.

## 7.3 Timestamp

All timestamps MUST be RFC 3339 strings.

## 7.4 TermSet

Offer-like objects carry a `terms` or `proposed_terms` object.

KNP/1.0 defines the stable top-level domains:

- `items`
- `price_terms`
- `fulfillment_terms`
- `service_terms`
- `payment_terms`
- `valid_until`

`payment_terms` MAY express a negotiated commercial condition but MUST NOT authorize or execute payment.

---

# 8. Kiwi Negotiation Envelope

Every KNP wire payload MUST be carried inside a Negotiation Envelope.

```json
{
  "capability": "com.harrylabsj.kiwi.shopping.negotiation",
  "protocol_version": "1.0",
  "negotiation_id": "neg_01...",
  "exchange_id": "ex_01...",
  "message_id": "msg_01...",
  "in_reply_to": "msg_00...",
  "actor": "buyer",
  "action": "counter_offer",
  "created_at": "2026-08-05T12:00:00Z",
  "payload": {},
  "public_message": "If we order 200 units, we propose CNY 835.00 per unit.",
  "digest": "sha256:..."
}
```

## 8.1 `actor`

Allowed values:

```text
buyer
merchant
```

System/internal runtime events MUST NOT masquerade as either commercial actor.

## 8.2 `action`

KNP/1.0 actions are:

```text
inquiry
rfq
offer
counter_offer
conditional_offer
clarification
clarification_response
accept_nonbinding
withdraw
decline
cancel
```

`accepted_nonbinding_agreement` is a resulting agreement artifact and MAY be returned in a response or A2A Task artifact.

## 8.3 `public_message`

`public_message` is OPTIONAL human-readable text.

The structured `payload` is authoritative for protocol semantics.

If `public_message` contradicts the structured payload, the receiver MUST NOT silently infer corrected business terms from the text.

The receiver SHOULD return `structured_text_conflict` or route the exchange for human review.

## 8.4 Sensitive Data

An envelope MUST NOT contain a private budget ceiling, Merchant cost, Merchant floor price, secret credential, private memory record, or other restricted value unless an explicit disclosure policy permits that exact field.

## 8.5 `in_reply_to`

`in_reply_to` is OPTIONAL unless the action-specific rule requires a reply reference.

When present, it MUST reference a known KNP `message_id` in the same negotiation.

`clarification_response` MUST set `in_reply_to` to the Clarification message being answered. An implementation MUST NOT infer a missing required reply reference from human-readable text.

---

# 9. Inquiry

Inquiry asks a non-binding question without creating an offer.

Example:

```json
{
  "type": "inquiry",
  "subject": {
    "sku": "SKU-001"
  },
  "questions": [
    {
      "code": "delivery.estimated_date"
    }
  ]
}
```

A receiver MAY answer an Inquiry with a normal KNP response, Clarification, or an A2A Task when asynchronous work is required.

An Inquiry MUST NOT be interpreted as purchase intent.

---

# 10. RFQ

An RFQ requests commercial terms.

Example:

```json
{
  "type": "rfq",
  "items": [
    {
      "sku": "SKU-001",
      "quantity": {
        "value": 200,
        "unit": "piece"
      }
    }
  ],
  "requested_terms": {
    "delivery_before": "2026-08-20T18:00:00Z"
  }
}
```

An RFQ MUST contain at least one item.

If required information is missing but recoverable through dialogue, the receiver SHOULD issue a Clarification instead of rejecting the negotiation.

---

# 11. Offer

An Offer is a non-binding commercial proposal.

Example:

```json
{
  "type": "offer",
  "offer_id": "off_01...",
  "terms": {
    "items": [
      {
        "sku": "SKU-001",
        "quantity": {
          "value": 200,
          "unit": "piece"
        },
        "unit_price": {
          "currency": "CNY",
          "amount_minor": 85000
        }
      }
    ],
    "fulfillment_terms": {
      "delivery_before": "2026-08-20T18:00:00Z"
    },
    "valid_until": "2026-08-06T12:00:00Z"
  }
}
```

The Offer issuer MUST NOT describe the Offer as an order or sale completion.

An Offer with `valid_until` MUST NOT be accepted after that timestamp.

---

# 12. CounterOffer

A CounterOffer is a new offer-like proposal responding to a prior Offer, CounterOffer, or ConditionalOffer.

Example:

```json
{
  "type": "counter_offer",
  "offer_id": "off_02...",
  "responding_to_offer_id": "off_01...",
  "proposed_terms": {
    "items": [
      {
        "sku": "SKU-001",
        "quantity": {
          "value": 200,
          "unit": "piece"
        },
        "unit_price": {
          "currency": "CNY",
          "amount_minor": 83500
        }
      }
    ]
  }
}
```

KNP/1.0 CounterOffer uses complete `proposed_terms` for all commercially material fields that the receiver needs to evaluate.

Implementations MUST NOT use arbitrary executable patch expressions.

A receiver MUST reject a CounterOffer whose referenced offer is unknown, withdrawn, or expired.

---

# 13. ConditionalOffer

ConditionalOffer expresses deterministic alternative terms.

## 13.1 Structure

```json
{
  "type": "conditional_offer",
  "offer_id": "off_03...",
  "responding_to_offer_id": "off_02...",
  "base_terms": {},
  "conditions": [
    {
      "when": {
        "all": [
          {
            "field": "aggregate.total_quantity",
            "op": "gte",
            "value": 500
          }
        ]
      },
      "then_terms": {
        "items": []
      }
    }
  ]
}
```

## 13.2 Determinism

Conditions MUST be deterministic.

Conditions MUST NOT contain:

- JavaScript;
- Python;
- SQL;
- arbitrary `eval`;
- arbitrary regex execution;
- arbitrary JSONPath;
- network callbacks;
- model-generated executable expressions.

## 13.3 Boolean Grammar

KNP/1.0 supports:

```text
all
any
```

A node MUST contain exactly one of:

- `all`
- `any`
- a comparison leaf

Condition depth is counted explicitly:

```text
root condition node = depth 0
child boolean node  = depth 1
comparison leaf     = depth 1 or depth 2
```

No node may appear below depth 2. In particular, a boolean node at depth 2 MUST NOT contain another boolean child.

## 13.4 Comparison Operators

Allowed operators:

```text
eq
neq
gt
gte
lt
lte
in
```

## 13.5 Field Vocabulary

Allowed field identifiers are protocol-governed.

KNP/1.0 initial vocabulary:

```text
aggregate.total_quantity
fulfillment.batch_count
service.warranty_months
commercial.commitment_days
```

A receiver MUST reject an unsupported condition field with `field_unsupported`.

## 13.6 Evaluation

For each rule:

1. evaluate `when`;
2. collect all matching rules;
3. if no rule matches, use `base_terms`;
4. if exactly one rule matches, use that rule's complete `then_terms`;
5. if more than one matching rule produces non-identical complete `then_terms`, return `condition_conflict`;
6. implementations MUST NOT implicitly merge distinct matching `then_terms` field-by-field;
7. if multiple matching rules produce byte-equivalent canonical `then_terms`, they MAY be treated as one result.

A model MUST NOT choose among conflicting matching rules.

---

# 14. Clarification

Clarification requests missing or ambiguous information.

Example:

```json
{
  "type": "clarification",
  "questions": [
    {
      "field": "fulfillment.delivery_before",
      "reason": "missing"
    }
  ]
}
```

Both Buyer and Merchant MAY request Clarification.

A Clarification MUST NOT itself change accepted commercial terms.

A `clarification_response` MUST reference the clarification message being answered through envelope `in_reply_to`.

---

# 15. AcceptNonbinding

Acceptance references one active offer-like object.

Example:

```json
{
  "type": "accept_nonbinding",
  "offer_id": "off_03...",
  "terms_digest": "sha256:..."
}
```

A receiver MUST verify:

- the offer exists;
- the offer is not withdrawn;
- the offer is not expired;
- `terms_digest` matches the canonical digest of the offer terms;
- the accepting actor is the counterparty to the active offer.

If any check fails, no agreement may be created.

---

# 16. AcceptedNonbindingAgreement

A successful valid acceptance produces or confirms an AcceptedNonbindingAgreement.

Example:

```json
{
  "type": "accepted_nonbinding_agreement",
  "agreement_id": "agr_01...",
  "negotiation_id": "neg_01...",
  "accepted_offer_id": "off_03...",
  "agreed_terms": {},
  "terms_digest": "sha256:...",
  "accepted_by": [
    "buyer",
    "merchant"
  ],
  "created_at": "2026-08-05T12:30:00Z",
  "binding_effect": "nonbinding",
  "creates_order": false,
  "reserves_inventory": false,
  "authorizes_payment": false
}
```

The three side-effect flags MUST be present and MUST be `false` in KNP/1.0.

An implementation MUST reject an agreement artifact that sets any of them to `true`.

An agreement MUST be traceable to the accepted offer and its terms digest.

---

## 16.1 Downstream Transaction Handoff

KNP/1.0 ends when a valid `AcceptedNonbindingAgreement` is produced.

A host runtime MAY use that Agreement as input to a separate Transaction Handoff layer.

```text
AcceptedNonbindingAgreement
        ↓
Transaction Handoff
        ↓
external checkout / ERP / PO / contact
```

This does not extend KNP/1.0 transaction authority.

A Handoff implementation MUST preserve:

```text
agreement_id
negotiation_id
terms_digest
counterparty identity
```

and MUST NOT reinterpret the Agreement as:

```text
order created
payment authorized
inventory reserved
contract executed
```

Transaction Handoff is governed by a separate child specification and is not required for KNP/1.0 conformance.

# 17. Withdraw, Decline, and Cancel

## 17.1 Target Reference

KNP uses stable message-level references for objects that do not otherwise carry their own business object identifier.

A target reference MUST contain:

```json
{
  "target_message_id": "msg_..."
}
```

For Offer-like targets, it SHOULD additionally contain:

```json
{
  "target_offer_id": "off_..."
}
```

When both are present, they MUST resolve to the same Ledger object.

A receiver MUST return `state_conflict` if the references disagree.

## 17.2 Withdraw

Withdraw retracts an actor's own still-withdrawable message or Offer-like object.

```json
{
  "type": "withdraw",
  "target_message_id": "msg_03...",
  "target_offer_id": "off_03...",
  "scope": "offer",
  "reason_code": "commercial_terms_changed"
}
```

Allowed `scope` values:

```text
offer
negotiation
```

`scope=offer` closes the referenced active offer and normally returns the business negotiation to `OPEN`.

`scope=negotiation` transitions the negotiation to `WITHDRAWN`.

An actor MUST NOT withdraw an object authored by the counterparty.

## 17.3 Decline

Decline communicates a commercial decision, not a protocol error.

```json
{
  "type": "decline",
  "target_message_id": "msg_03...",
  "target_offer_id": "off_03...",
  "scope": "offer",
  "reason_code": "terms_unacceptable"
}
```

`scope=offer` closes the referenced offer and leaves the negotiation open.

`scope=negotiation` transitions the negotiation to `DECLINED`.

For negotiation-level decline, the envelope `negotiation_id` is authoritative and a synthetic object ID MUST NOT be invented.

## 17.4 Cancel

`cancel` transitions a non-terminal negotiation to `CANCELLED`.

Cancel MUST NOT be used to claim that a separate order has been cancelled.

KNP/1.0 does not manage orders.

`AGREEMENT_REACHED`, `DECLINED`, `WITHDRAWN`, `CANCELLED`, and terminal negotiation `EXPIRED` states MUST NOT be reopened under the same `negotiation_id`.


# 18. Protocol Errors

Protocol errors are not commercial Declines.

KNP/1.0 defines at least:

```text
protocol_version_unsupported
capability_incompatible
schema_invalid
field_unsupported
structured_text_conflict
identity_rejected
authentication_required
authorization_failed
offer_unknown
offer_expired
offer_withdrawn
terms_digest_mismatch
condition_conflict
state_conflict
approval_required
idempotency_conflict
replay_detected
rate_limited
temporarily_unavailable
reconciliation_required
```

A protocol error MUST NOT advance the commercial negotiation as if an Offer, CounterOffer, Decline, or Agreement had occurred.

Retryability MUST be explicit.

---

# 19. Canonicalization and Digest

## 19.1 Canonicalization

KNP/1.0 uses RFC 8785 JSON Canonicalization Scheme (JCS).

Objects used for hashing MUST satisfy JCS/I-JSON constraints.

## 19.2 Envelope Digest

To compute the envelope digest:

1. take the KNP Negotiation Envelope JSON object;
2. remove exactly the top-level `digest` member;
3. do **not** remove any other KNP envelope member;
4. transport wrapper fields, HTTP headers, A2A signatures, JWS containers, or other transport-specific signatures MUST live outside the KNP envelope and therefore are never part of the KNP digest input;
5. canonicalize the remaining envelope with RFC 8785 JCS;
6. compute SHA-256 over UTF-8 canonical bytes;
7. encode as lowercase hexadecimal prefixed by `sha256:`.

An implementation MUST NOT invent a local “signature-field stripping” list inside the KNP envelope.

## 19.3 Terms Digest

`terms_digest` is the SHA-256 digest of the RFC 8785 canonical representation of the agreed offer terms object alone.

---

# 20. Idempotency and Replay

## 20.1 Idempotency Key

The logical KNP idempotency key is:

```text
(sender_identity, message_id)
```

## 20.2 Exact Retry

If the receiver sees:

```text
same sender_identity
same message_id
same digest
```

it MUST NOT perform the business effect twice.

It MUST return the previous result or a semantically equivalent acknowledgment.

## 20.3 Conflict

If the receiver sees:

```text
same sender_identity
same message_id
different digest
```

it MUST return:

```text
idempotency_conflict
```

and MUST NOT apply the new payload.

## 20.4 Replay Outside Valid State

A byte-identical message MAY still be invalid because the referenced offer has expired or the negotiation has closed.

The receiver MUST distinguish:

- duplicate delivery of an already-processed action; from
- a new attempt to apply an old message in an incompatible state.

## 20.5 Retention

Implementations MUST retain enough idempotency metadata to cover any still-valid offer/task/negotiation replay window.

The reference Kiwi implementation SHOULD retain completed idempotency records for at least 24 hours after the negotiation becomes terminal, subject to stricter enterprise retention policy.

---

# 21. Negotiation State Machine

KNP business state is separate from approval state and A2A Task state.

## 21.1 Negotiation Phases

```text
OPEN
AWAITING_CLARIFICATION
OFFER_OPEN
AGREEMENT_REACHED
DECLINED
WITHDRAWN
CANCELLED
EXPIRED
```

## 21.2 Core Transition Table

| Current | Event | Next | Notes |
|---|---|---|---|
| none | Inquiry/RFQ start | OPEN | creates negotiation |
| OPEN | Clarification | AWAITING_CLARIFICATION | save resume phase |
| AWAITING_CLARIFICATION | valid clarification_response | previous phase | restore |
| OPEN | Offer | OFFER_OPEN | active offer set |
| OFFER_OPEN | CounterOffer | OFFER_OPEN | active offer replaced |
| OFFER_OPEN | ConditionalOffer | OFFER_OPEN | active offer replaced |
| OFFER_OPEN | Clarification | AWAITING_CLARIFICATION | resume to OFFER_OPEN |
| OFFER_OPEN | active offer expires | OPEN | active offer cleared |
| OFFER_OPEN | valid AcceptNonbinding | AGREEMENT_REACHED | agreement produced |
| OFFER_OPEN | Withdraw scope=offer | OPEN | target offer closed |
| non-terminal | Withdraw scope=negotiation | WITHDRAWN | terminal; includes AWAITING_CLARIFICATION |
| OFFER_OPEN | Decline scope=offer | OPEN | target offer closed |
| AWAITING_CLARIFICATION (resume=OFFER_OPEN) | Decline scope=offer | OPEN | target active offer closed; pending clarification no longer blocks closure |
| non-terminal | Decline scope=negotiation | DECLINED | terminal; includes AWAITING_CLARIFICATION |
| non-terminal | Cancel | CANCELLED | terminal |
| non-terminal | negotiation expiry | EXPIRED | terminal |

A terminal negotiation MUST NOT accept a new commercial action under the same `negotiation_id`.

A new negotiation requires a new `negotiation_id`.

---

# 22. Approval State

Approval is orthogonal to negotiation phase.

States:

```text
NOT_REQUIRED
PENDING
APPROVED
REJECTED
STALE
```

An approval MUST bind at least:

- `candidate_id`;
- candidate digest;
- remote revision or equivalent remote precondition;
- policy version;
- counterparty identity snapshot.

Before sending an approved candidate, the runtime MUST re-read remote state and MUST revalidate the candidate.

If a bound precondition changed, the approval MUST transition to `STALE`.

---

# 23. A2A Message vs Task

KNP uses A2A Message for interactions that can complete in a bounded conversational turn.

KNP SHOULD use A2A Task when any of these apply:

- human approval is required;
- internal enterprise approval is required;
- supply-chain or inventory work is asynchronous;
- pricing calculation is long-running;
- an asynchronous artifact is expected.

A2A Task is a lifecycle carrier.

It does not replace KNP domain objects.

An Offer returned as a Task artifact is still an Offer and MUST validate against the same Offer schema.

---

# 24. A2A Binding

## 24.1 Discovery

An A2A server supporting KNP SHOULD expose an Agent Card at:

```text
/.well-known/agent-card.json
```

The Agent Card MUST advertise the A2A interfaces it actually supports.

The Agent Card SHOULD advertise the KNP extension URI.

## 24.2 Extension Activation

When the selected A2A binding supports extension negotiation through the `A2A-Extensions` mechanism, a KNP client SHOULD request the KNP extension URI.

If KNP is required for the intended interaction and the remote agent does not support it, the client MUST fail with `capability_incompatible`.

## 24.3 Message Representation

A KNP commercial message carried in A2A SHOULD contain:

- a structured data part containing the KNP Negotiation Envelope;
- optionally a human-readable text part semantically consistent with `public_message`.

The receiver MUST validate the structured part before using it as commercial state.

## 24.4 `contextId`

The KNP runtime MUST persist remote `contextId` when provided and SHOULD reuse it for subsequent interaction in the same negotiation.

## 24.5 `taskId`

The runtime MAY attach or reuse A2A `taskId` only according to A2A task-continuation semantics.

KNP MUST NOT synthesize fake A2A task IDs.

---

# 25. UCP Advertisement

A business supporting KNP over A2A MAY advertise an A2A service in its UCP profile.

The A2A service endpoint refers to the Agent Card URL.

KNP MUST be advertised as a vendor capability using the vendor's controlled reverse-domain namespace.

A KNP vendor capability MUST provide `version`, `spec`, and `schema` according to UCP rules.

The `spec` and `schema` origins MUST match the capability namespace authority.

KNP/1.0 is a vendor root capability by default and therefore MUST NOT include `extends` unless a future version explicitly extends a UCP parent capability.

Capability negotiation MUST use the intersection of both parties' advertised supported capabilities.

---

# 26. Discovery and Channel Separation

`AgentDiscovery` resolves identity, profiles, capabilities, Agent Cards, and candidate channels.

An implementation MAY use:

```text
kiwi-catalog
well-known discovery
direct configuration
enterprise registry
another curated registry
```

KNP/1.0 does not require kiwi-catalog.

`CounterpartyChannel` performs communication after discovery.

A channel MUST NOT silently widen disclosure or authorization when fallback occurs.

If Direct A2A fails, the runtime MUST NOT automatically fall back to a more privileged hosted channel unless policy explicitly allows that fallback.

Product, inventory, pricing, delivery and merchant operating data are outside KNP discovery semantics. A Merchant runtime MAY obtain those facts from shopping-cli, ERP, PIM, local databases, or other authorized CommerceDataSources.

# 27. Recovery and Reconciliation

After restart, a direct KNP implementation MUST NOT assume the local ledger alone is current.

Reference recovery flow:

1. load local negotiation metadata;
2. load ledger high-water mark;
3. resolve the counterparty/channel;
4. retrieve current remote A2A context/task state when available;
5. compare acknowledged messages;
6. reconcile remote state with local ledger;
7. invalidate stale candidates and approvals;
8. resume schedulers/subscriptions.

If local state contains an outbound message whose acceptance is unknown, the implementation MAY safely resend only when the same `message_id` and digest are preserved.

If remote and local states cannot be safely reconciled, the implementation MUST enter `reconciliation_required` and MUST NOT generate a new commercial commitment automatically.

---

# 28. Negotiation Ledger

A conforming Kiwi runtime SHOULD maintain an append-only negotiation ledger.

Each ledger event SHOULD contain:

- event identifier;
- negotiation_id;
- message/exchange references;
- sender/counterparty identity snapshot;
- capability/version snapshot;
- wire digest;
- remote context/task references;
- state transition;
- result/error;
- timestamp;
- previous event digest.

A Kiwi reference implementation SHOULD hash-link ledger events.

The ledger MUST NOT contain raw chain-of-thought or private-vault plaintext.

---

# 29. Trust and Identity

KNP distinguishes:

1. Identity Trust — who is the counterparty?
2. Protocol Trust — does it behave according to protocol?
3. Commercial Reputation — is it a good counterparty to transact with?

These MUST NOT be collapsed into one score.

An Agent Card signature MAY strengthen identity evidence but is not universally mandatory under A2A.

Deployment TrustPolicy determines when JWS, OAuth/OIDC, mTLS, HTTP Message Signatures, or other verification is required.

A valid protocol identity MUST NOT be presented to the user as proof of product quality or merchant reputation.

---

# 30. Disclosure and Fan-out Privacy

A Buyer runtime MUST apply disclosure policy before transmitting RFQs.

Fan-out SHOULD be bounded by policy, including:

- `max_recipients`;
- minimum trust level;
- first-round disclosure profile;
- whether exact quantity is disclosed;
- whether organization identity is disclosed;
- whether precise delivery location is disclosed.

A runtime SHOULD support progressive disclosure.

Example:

```text
Round 1 → broad quantity range to 5 merchants
Round 2 → exact quantity and delivery requirements to top 2
```

---

# 31. Abuse Mitigation

A public Merchant KNP endpoint MUST implement resource protection appropriate to its deployment.

Controls SHOULD include:

- per-identity rate limits;
- per-domain rate limits;
- payload-size limits;
- task concurrency limits;
- backoff;
- malformed-request budgets;
- replay-flood protection;
- trust-based throttling.

A Merchant MUST be able to return `rate_limited` without converting it into a commercial Decline.

---

# 32. Legacy shopping-cli Mapping

`shopping.negotiation/0.1` remains a legacy wire contract.

KNP/1.0 remains the canonical negotiation domain.

A `LegacyNegotiationAdapter` MAY translate between them.

Translation rules:

```text
lossless → translate
lossy → fail closed
unsupported → human/fallback
```

The adapter MUST NOT silently drop:

- conditions;
- expiry;
- identity semantics;
- agreement semantics.

Claim/heartbeat semantics remain internal to `ShoppingCliHostedChannel` and MUST NOT be projected onto Direct A2A as fake protocol state.

`kiwi-catalog` is not part of this legacy mapping. It is discovery infrastructure.

shopping-cli MAY additionally serve as a Merchant commerce data source for product, inventory, pricing, delivery and business facts. Those data-source semantics are outside KNP/1.0 wire semantics.

# 33. Security Invariants

A conforming Kiwi KNP implementation MUST preserve:

1. one runtime instance represents one principal role;
2. Buyer and Merchant private memory/vault/credentials remain isolated;
3. reasoning backends do not own unrestricted commerce credentials;
4. model output never directly becomes a network side effect;
5. remote agents do not receive principal memory by default;
6. unknown versions fail closed;
7. invalid schema fails closed;
8. same message ID with different digest fails closed;
9. stale approvals are not sent;
10. executable conditions are forbidden;
11. public text cannot override structured terms;
12. KNP/1.0 creates no order;
13. KNP/1.0 performs no payment;
14. KNP/1.0 performs no refund;
15. KNP/1.0 reserves no inventory;
16. raw chain-of-thought is not persisted as protocol state;
17. remote protocol content is treated as untrusted input;
18. remote content MUST NOT automatically invoke arbitrary local tools;
19. remote messages MUST NOT be written directly into Principal Memory;
20. Agent Cards, UCP Profiles, and public protocol metadata MUST NOT contain static secrets.
21. A downstream Transaction Handoff MUST NOT be represented as a KNP order/payment/inventory side effect.

---

# 34. Conformance Levels

## 34.1 KNP Core

A Core implementation MUST support:

- Envelope;
- Inquiry;
- RFQ;
- Offer;
- CounterOffer;
- Clarification;
- AcceptNonbinding;
- Agreement;
- Withdraw;
- Decline;
- errors;
- idempotency;
- state transitions.

## 34.2 KNP Conditional

An implementation claiming `knp-conditional` MUST additionally support:

- ConditionalOffer;
- deterministic condition evaluator;
- all required condition test vectors.

## 34.3 KNP A2A

An implementation claiming `knp-a2a` MUST:

- expose or consume a valid A2A Agent Card;
- carry KNP structured data in A2A interactions;
- preserve contextId/taskId semantics;
- pass A2A interop tests.

## 34.4 KNP UCP

An implementation claiming `knp-ucp` MUST:

- publish/consume the UCP vendor capability;
- pass namespace/spec/schema origin validation;
- perform capability intersection correctly.

---

# 35. Required Test Categories

A conforming implementation MUST test:

## Schema

- valid/invalid envelope;
- valid/invalid Money;
- invalid float money;
- each payload schema;
- unknown required enum values.

## State

- Offer → CounterOffer;
- Offer → Clarification → resume;
- Offer expiry → OPEN;
- Offer → Accept → Agreement;
- terminal negotiation rejects new commercial action.

## Idempotency

- same ID + same digest;
- same ID + different digest;
- retry after lost response.

## ConditionalOffer

- zero match;
- one match;
- multiple identical matches;
- conflicting matches;
- unsupported field;
- excessive nesting.

## Security

- private budget leakage;
- merchant floor leakage;
- structured/text contradiction;
- replay attack;
- forged identity;
- stale approval.

## Recovery

- restart after outbound send before response;
- remote ahead of local ledger;
- local pending / remote accepted;
- irreconcilable conflict.

---

# 36. Version 1.0 Conformance and Interoperability Gates

KNP/1.0 protocol conformance requires:

1. the canonical contract schema at `contracts/negotiation/1.0/schema.json` validates required protocol objects;
2. normative examples validate against the canonical schema;
3. digest tests are reproducible;
4. condition tests are deterministic;
5. transition tests pass;
6. duplicate message behavior passes;
7. UCP capability advertisement passes namespace-origin validation;
8. legacy adapter loss cases fail closed;
9. no-order/no-payment/no-reservation invariants hold.

A separate **cross-implementation interoperability claim** requires at least one A2A/KNP peer implemented independently from the Kiwi reference implementation.

Until that evidence exists, Kiwi MAY claim KNP/1.0 reference conformance and bilateral reference interoperability, but MUST NOT claim verified independent/cross-vendor interoperability.

Transaction Handoff is intentionally outside KNP/1.0 conformance. A runtime may implement Handoff only as a downstream layer bound to a valid Agreement.

# Appendix A — Reference Artifact Layout

Current repository authority:

```text
docs/protocol/
  kiwi-negotiation-protocol-1.0-rev1.4.md

contracts/negotiation/1.0/
  schema.json
```

Protocol test evidence currently lives in the repository test suite and
`docs/reviews/a2a-sdk-conformance-transcript.jsonl`. This specification MUST
NOT cite a standalone `schemas/` or `test-vectors/` directory unless those
artifacts actually exist and are version-controlled.

A future dedicated vector bundle MAY be introduced, but its path becomes normative only after it is committed and referenced here.

# Appendix B — External Standards Baseline

KNP/1.0 relies on, but does not redefine:

- Agent2Agent Protocol (A2A) 1.0;
- Universal Commerce Protocol (UCP) 2026-04-08 family;
- RFC 2119 / RFC 8174 requirements language;
- RFC 3339 timestamps;
- RFC 8785 JSON Canonicalization Scheme;
- SHA-256.

The public KNP capability namespace and HTTPS specification origin are hosted under the Kiwi-controlled authority `https://kiwi.harrylabsj.com` (online since 2026-08-06).

---

# Appendix C — rev1.4 Errata Summary

This document revision does not change the KNP wire version (`1.0`). It:

- closes `AWAITING_CLARIFICATION` Withdraw/Decline transition gaps;
- defines condition depth counting precisely;
- defines `in_reply_to` near the envelope;
- removes digest signature-stripping ambiguity;
- separates spec publication from independent/cross-vendor interop claims;
- points to the actual canonical contract schema path.
