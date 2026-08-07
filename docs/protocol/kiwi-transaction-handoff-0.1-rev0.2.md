---
title: Kiwi Transaction Handoff
doc_revision: "0.2"
short_name: KTH/0.1
date: 2026-08-07
status: Proposed Specification — Implementation Draft
scope: Agreement-to-External-Transaction Bridge
---

# Kiwi Transaction Handoff 0.1

## 1. Purpose

Kiwi Transaction Handoff defines how a Kiwi runtime takes a valid pre-transaction agreement and safely transfers it to a real transaction destination without pretending that Kiwi itself created an order, authorized payment, reserved inventory, or completed fulfillment.

Core flow:

```text
AcceptedNonbindingAgreement
        ↓
Buyer selected_nonbinding
        ↓
HandoffCandidate
        ↓
Policy / Approval
        ↓
TransactionHandoff
        ↓
External Transaction Destination
```

Handoff exists to close the commercial usability gap between:

```text
“谈妥了”
```

and:

```text
“用户现在可以去真实系统成交”
```

## 2. Non-Goals

KTH/0.1 does NOT define:

```text
order creation
payment authorization
refund
escrow
inventory reservation
shipment
fulfillment
legal contract execution
```

A downstream system may perform those actions under its own authority.

## 3. Design Principle

> Handoff is a bridge, not a transaction protocol.

The following are never equivalent:

```text
Agreement != Order
Handoff != Checkout completion
Opened URL != Payment success
PO draft != Accepted purchase order
```

## 4. Inputs

A Handoff MUST start from a traceable commercial result.

Preferred input:

```text
AcceptedNonbindingAgreement
```

A Buyer MAY first mark one of several Agreements as:

```text
selected_nonbinding
```

`selected_nonbinding` remains Buyer-local state.

## 5. HandoffCandidate

Before external action, Kiwi creates an immutable candidate:

```json
{
  "handoff_candidate_id": "hcan_01...",
  "supersedes_candidate_id": null,
  "agreement_id": "agr_01...",
  "negotiation_id": "neg_01...",
  "terms_digest": "sha256:...",
  "buyer_identity_ref": "principal:buyer-local-ref",
  "merchant_identity_ref": "merchant:...",
  "destination_type": "external_checkout_url",
  "destination_ref": "https://merchant.example/checkout/...",
  "destination_payload": {},
  "display_summary": {
    "merchant": "Example Merchant",
    "summary": "500 units under agreed terms"
  },
  "policy_version": "handoff-policy/1",
  "expires_at": "2026-08-08T12:00:00Z",
  "requires_user_action": true,
  "creates_order": false,
  "authorizes_payment": false,
  "reserves_inventory": false,
  "candidate_digest": "sha256:...",
  "created_at": "2026-08-07T12:00:00Z"
}
```

The candidate MUST bind:

```text
agreement_id
negotiation_id
terms_digest
merchant identity
destination type/reference/payload
policy version
expiry
side-effect=false invariants
```

`buyer_identity_ref` is a local/audit reference and MUST NOT be disclosed to the destination unless disclosure policy explicitly permits it.

`destination_payload` MUST be minimal, schema-validated, and secret-free.

### 5.1 Candidate Lifecycle

```text
PROPOSED
  ├─ policy/approval + revalidation → READY
  ├─ rejection                   → REJECTED
  ├─ bound input changes         → STALE
  └─ expiry                      → EXPIRED

READY
  ├─ successful handoff creation/delivery → CONSUMED
  ├─ bound input changes                  → STALE
  └─ expiry                               → EXPIRED
```

Terminal Candidate states:

```text
CONSUMED
STALE
REJECTED
EXPIRED
```

A STALE candidate MUST NOT be revived. Kiwi MUST create a new candidate with a new `handoff_candidate_id`; it SHOULD set `supersedes_candidate_id` to the stale candidate for audit linkage.

## 6. Handoff Object

A Handoff object is created only after the source candidate is `READY`, the bound inputs are revalidated, and the delivery action succeeds.

```json
{
  "handoff_id": "hnd_01...",
  "source_candidate_id": "hcan_01...",
  "source_candidate_digest": "sha256:...",
  "agreement_id": "agr_01...",
  "negotiation_id": "neg_01...",
  "terms_digest": "sha256:...",
  "merchant_identity_ref": "merchant:...",
  "destination_type": "external_checkout_url",
  "destination_ref": "https://merchant.example/checkout/...",
  "display_summary": {
    "merchant": "Example Merchant",
    "summary": "500 units under agreed terms"
  },
  "created_at": "2026-08-07T12:00:00Z",
  "expires_at": "2026-08-08T12:00:00Z",
  "requires_user_action": true,
  "creates_order": false,
  "authorizes_payment": false,
  "reserves_inventory": false,
  "handoff_digest": "sha256:..."
}
```

Relationship:

```text
one READY HandoffCandidate
        ↓ execute once / idempotently
zero or one successful Handoff
```

A retry using the same source candidate and unchanged destination MUST return the same Handoff result or an equivalent acknowledgment; it MUST NOT create multiple externally visible handoffs when the destination semantics are idempotent/can be made idempotent.

A failed delivery attempt is an audit event. It does not create a successful Handoff object and does not imply transaction failure.

## 7. Destination Types

### 7.1 Standard UCP

Preferred when supported:

```text
ucp_checkout
ucp_order
```

Kiwi SHOULD use standard UCP capabilities rather than inventing parallel transaction semantics.

### 7.2 Merchant Checkout

```text
external_checkout_url
merchant_checkout_session
```

The merchant system remains authoritative.

### 7.3 Platform Deep Link

Examples:

```text
marketplace product URL
marketplace checkout/deep link
mini-program link
```

Kiwi MUST NOT bypass platform access controls or fabricate privileged APIs.

### 7.4 Buyer ERP / Procurement

```text
buyer_erp_request
procurement_request
```

This may create an internal purchase request only when the Buyer organization explicitly authorizes that local action.

An internal purchase request is not automatically a Merchant order.

### 7.5 Documents

```text
purchase_order_draft
quote_document
```

A generated PO is a draft unless a separate enterprise workflow formally submits/approves it.

### 7.6 Human Contact

```text
merchant_contact
sales_handoff
```

Used when no machine checkout is available.

## 8. Destination Selection

Recommended preference:

```text
1. standard UCP checkout/order capability
2. merchant-controlled checkout
3. buyer ERP / procurement workflow
4. platform deep link
5. PO / quote document
6. merchant contact
```

Selection MUST consider:

```text
trust
capability support
agreement validity
user preference
enterprise policy
destination freshness
minimum privilege
```

## 9. Handoff Delivery State

Candidate state is defined separately in §5.1.

A successfully created Handoff has a small delivery-state model:

```text
DELIVERED
OPENED
EXPIRED
REVOKED
```

Transition table:

| Current | Event | Next | Notes |
|---|---|---|---|
| none | successful destination delivery | DELIVERED | creates `handoff_id`; source candidate → CONSUMED |
| DELIVERED | destination open/launch observed | OPENED | observation only; not transaction success |
| DELIVERED | destination expires before open | EXPIRED | no transaction state inferred |
| DELIVERED | revocation supported and succeeds | REVOKED | only when destination supports revocation |
| OPENED | any local observation | OPENED | terminal for KTH delivery semantics |
| EXPIRED | any | EXPIRED | terminal |
| REVOKED | any | REVOKED | terminal |

Delivery failure before a Handoff object is successfully created is recorded as:

```text
handoff_delivery_failed
```

against the Candidate/attempt; it does not create a `FAILED` transaction-like Handoff state.

KTH/0.1 MUST NOT define or infer:

```text
ORDER_CREATED
PAID
SHIPPED
FULFILLED
REFUNDED
```

`OPENED` means only that Kiwi observed the destination being opened/launched. It is not proof of checkout completion.

## 10. Pre-Execution Revalidation

Immediately before Handoff:

```text
re-read Agreement
verify terms_digest
verify Merchant identity
verify destination
verify expiry
verify approval/policy
```

If any bound condition changed:

```text
candidate → STALE
```

and a new candidate is required.

## 10.1 Digests and Idempotency

KTH uses RFC 8785 JCS + SHA-256 for Candidate/Handoff digests.

For `candidate_digest`, canonicalize the HandoffCandidate after removing exactly `candidate_digest`.

For `handoff_digest`, canonicalize the Handoff object after removing exactly `handoff_digest`.

The execution idempotency key is:

```text
(source_candidate_id, source_candidate_digest)
```

Same source candidate + same digest:

```text
MUST NOT duplicate the external handoff effect
```

Same source candidate + different digest:

```text
handoff_idempotency_conflict
→ fail closed
```

## 11. Security

### 11.1 Secrets

A Handoff MUST NOT expose:

```text
Buyer private budget
Merchant cost/floor
API key
Bearer token
private signing key
raw Principal Memory
```

### 11.2 URL Safety

For external URLs:

```text
HTTPS by default
redirect limit
block unsafe schemes
display final destination
anti-phishing checks
optional allowlist / enterprise policy
```

### 11.3 Payload Minimization

Only fields required by the destination should be transmitted.

## 12. Audit / Ledger

Kiwi SHOULD record:

```text
handoff_candidate_created
handoff_approved
handoff_delivered
handoff_opened
handoff_expired
handoff_revoked
handoff_failed
```

Each record SHOULD bind:

```text
agreement_id
terms_digest
destination digest
counterparty identity
timestamp
```

The Ledger MUST NOT claim external transaction success without an authoritative external event.

## 13. Relationship to KNP

KNP/1.0 ends at `AcceptedNonbindingAgreement`.

KTH/0.1 consumes that Agreement but does not modify it.

```text
KNP
= negotiation truth

KTH
= downstream destination bridge
```

## 14. Relationship to kiwi-catalog

kiwi-catalog MAY index public Handoff capabilities such as:

```text
supports_external_checkout
supports_ucp_checkout
supports_erp_handoff
supports_quote_document
```

It MUST NOT store private transaction payloads or Buyer-specific Handoff objects.

## 15. Relationship to shopping-cli

shopping-cli MAY provide the Merchant-side data needed to construct a Handoff:

```text
SKU mapping
public product URL
checkout URL template
inventory freshness
delivery facts
quote metadata
ERP references
```

shopping-cli remains Merchant commerce data/operations infrastructure.

## 16. MVP

KTH/0.1 MVP should support at least:

```text
external_checkout_url
purchase_order_draft
quote_document
merchant_contact
```

Recommended first E2E:

```text
Buyer Kiwi
→ kiwi-catalog discovers Merchant
→ KNP negotiation
→ AcceptedNonbindingAgreement
→ Buyer selects agreement
→ HandoffCandidate
→ user approval
→ merchant checkout URL / PO
```

## 17. Metrics

Core funnel:

```text
Need
→ Discovery
→ RFQ
→ Offer
→ Agreement
→ Handoff
→ Handoff Open
```

Recommended PMF metric:

> **Negotiation-to-Handoff Rate**

Secondary metrics:

```text
agreement_to_handoff_rate
handoff_open_rate
time_to_handoff
reported_external_conversion
```

`reported_external_conversion` MUST be labeled as externally reported unless Kiwi has authoritative transaction integration.

## 18. Completion Criteria

KTH/0.1 is implementation-ready when:

1. HandoffCandidate schema is frozen.
2. Handoff object schema is frozen.
3. Agreement/terms digest binding is tested.
4. stale candidate behavior is tested.
5. URL safety is tested.
6. no-order/no-payment/no-reservation invariants pass.
7. at least three destination types have E2E tests.
8. Ledger never infers external success from delivery/open alone.
9. Candidate lifecycle transition tests pass.
10. Handoff delivery-state transition tests pass.
11. candidate→handoff idempotency tests pass.


---

# Appendix A — Proposed Artifact Layout

KTH/0.1 is not frozen yet. The implementation SHOULD converge on:

```text
docs/protocol/
  kiwi-transaction-handoff-0.1.md

contracts/handoff/0.1/
  schema.json

tests/
  handoff candidate/state/digest/idempotency vectors
```

The `contracts/handoff/0.1/schema.json` path becomes canonical only when the file actually exists and is version-controlled.

---

# Appendix B — rev0.2 Review Closure

This revision:

- makes KTH the sole authority for Handoff object/state fields;
- adds `source_candidate_id` and explicit Candidate→Handoff linkage;
- separates Candidate lifecycle from Handoff delivery state;
- defines transition tables and stale-candidate replacement behavior;
- defines Candidate/Handoff digest and idempotency direction;
- adds a proposed artifact layout without pretending an uncommitted schema already exists.
