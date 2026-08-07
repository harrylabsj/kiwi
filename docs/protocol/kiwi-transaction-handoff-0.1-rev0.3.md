---
title: Kiwi Transaction Handoff
doc_revision: "0.3"
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
[selected_nonbinding] OPTIONAL
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
Launch success != Page-open proof
Opened-confirmed != Checkout completion
Opened-confirmed != Payment success
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

`selected_nonbinding` remains Buyer-local state and is OPTIONAL.

It is useful when the Buyer holds multiple candidate Agreements. A runtime MAY create a HandoffCandidate directly from a single unambiguous Agreement without first materializing `selected_nonbinding`.

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

### 5.1 Candidate Immutability and Lifecycle Projection

The HandoffCandidate document is immutable.

Lifecycle state is **not a mutable field inside the Candidate JSON**. It is an event-sourced runtime projection derived from Ledger events keyed by `handoff_candidate_id`.

Reference projection:

```text
PROPOSED
  ├─ policy/approval + revalidation → READY
  ├─ rejection                     → REJECTED
  ├─ bound input changes           → STALE
  └─ expiry                        → EXPIRED

READY
  ├─ successful handoff delivery   → CONSUMED
  ├─ bound input changes           → STALE
  └─ expiry                        → EXPIRED
```

Terminal lifecycle states:

```text
CONSUMED
STALE
REJECTED
EXPIRED
```

Canonical events:

```text
handoff_candidate_created
handoff_candidate_ready
handoff_candidate_rejected
handoff_candidate_stale
handoff_candidate_expired
handoff_candidate_consumed
```

A STALE Candidate MUST NOT be mutated or revived.

Kiwi MUST create a new immutable Candidate with a new `handoff_candidate_id`; it SHOULD set `supersedes_candidate_id` to the stale Candidate for audit linkage.

Therefore:

```text
Candidate content = immutable
Candidate lifecycle = mutable projection over immutable Ledger events
```

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

Candidate lifecycle is defined separately in §5.1.

A successfully created Handoff uses these delivery-observation states:

```text
DELIVERED
LAUNCHED
OPENED_CONFIRMED
EXPIRED
REVOKED
```

Definitions:

```text
DELIVERED
= Kiwi successfully made the Handoff destination available to the user/client.

LAUNCHED
= Kiwi/client successfully requested the OS/browser/deep-link handler to launch the destination.
  This does NOT prove that the page loaded.

OPENED_CONFIRMED
= Kiwi received explicit, attributable evidence that the destination was opened/reached.
  This is OPTIONAL because many external destinations provide no reliable callback.
```

Allowed evidence for `OPENED_CONFIRMED` MAY include:

```text
Kiwi-controlled client/webview callback
merchant callback tied to handoff_id
platform callback tied to handoff_id
verified return URI / signed callback
```

The following are insufficient for `OPENED_CONFIRMED`:

```text
button click alone
openURL()/shell launch returning success
browser process started
elapsed time
user-agent guess
```

Transition table:

| Current | Event | Next | Notes |
|---|---|---|---|
| none | successful handoff delivery | DELIVERED | creates `handoff_id`; source Candidate lifecycle → CONSUMED |
| DELIVERED | local launch request accepted | LAUNCHED | local observation only |
| DELIVERED | explicit verified open evidence | OPENED_CONFIRMED | direct callback path |
| LAUNCHED | explicit verified open evidence | OPENED_CONFIRMED | callback/return evidence |
| DELIVERED | destination expires | EXPIRED | no external transaction state inferred |
| LAUNCHED | destination expires without verified open evidence | EXPIRED | launch did not prove open |
| DELIVERED | revocation succeeds | REVOKED | only if destination supports revocation |
| OPENED_CONFIRMED | any local observation | OPENED_CONFIRMED | terminal for KTH delivery observation |
| EXPIRED | any | EXPIRED | terminal |
| REVOKED | any | REVOKED | terminal |

A delivery failure before a Handoff object is successfully created is recorded as:

```text
handoff_delivery_failed
```

against the Candidate/attempt; it does not create a transaction-like failure state.

KTH/0.1 MUST NOT define or infer:

```text
CHECKOUT_COMPLETED
ORDER_CREATED
PAID
SHIPPED
FULFILLED
REFUNDED
```

None of `DELIVERED`, `LAUNCHED`, or `OPENED_CONFIRMED` is proof of transaction success.

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
handoff_launched
handoff_opened_confirmed
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

kiwi-catalog MAY index the exact KTH destination vocabulary.

It SHOULD NOT invent a second `supports_*` vocabulary.

Canonical discovery representation:

```json
{
  "handoff_destination_types": [
    "external_checkout_url",
    "buyer_erp_request",
    "quote_document",
    "merchant_contact"
  ]
}
```

The values MUST be drawn from the KTH `destination_type` enum supported by that Merchant/Agent.

Therefore:

```text
catalog vocabulary
= KTH destination_type vocabulary
```

kiwi-catalog MUST NOT store private transaction payloads, Buyer-specific Handoff objects, or Handoff destination secrets.

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
handoff_launch_rate
opened_confirmed_rate
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
10. Handoff delivery-state transition tests pass, including DELIVERED→LAUNCHED and evidence-gated OPENED_CONFIRMED.
11. candidate→handoff idempotency tests pass.
12. a launch without callback evidence never becomes OPENED_CONFIRMED.
13. Candidate lifecycle state is reconstructed from Ledger events without mutating Candidate content.


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


---

# Appendix C — rev0.3 Consistency Patch

This revision closes the second-round review findings by:

- making `selected_nonbinding` explicitly optional;
- separating immutable Candidate content from event-sourced lifecycle projection;
- replacing ambiguous `OPENED` with `LAUNCHED` and evidence-gated `OPENED_CONFIRMED`;
- defining acceptable and unacceptable open evidence;
- deriving catalog Handoff discovery vocabulary directly from `destination_type`.
