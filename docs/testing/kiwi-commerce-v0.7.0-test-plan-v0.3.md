---
title: Kiwi Commerce v0.7.0 Test Plan
version: "0.3"
date: 2026-08-07
status: Draft Test Plan
---

# Kiwi Commerce v0.7.0 Test Plan

## 1. Scope

Covers v0.7.0 additions, plus backward-compatibility regression for the existing Agent Catalog (§2):

```text
kiwi-catalog Product-first Commerce Discovery
shopping-cli CommerceDataSource / authority model
Transaction Handoff
integration with already released KNP/1.0
existing Agent Catalog regression (registration, verification, freshness,
administrative states, hosted negotiation, stale search labeling)
```

## 2. kiwi-catalog

- registration and domain/profile validation;
- Agent Card/UCP capability indexing;
- VerificationLevel transitions;
- AgentFreshnessState transitions (FRESH/STALE/UNREACHABLE);
- AdministrativeState transitions (ACTIVE/SUSPENDED/REJECTED);
- orthogonal combined-state rendering;
- scheduled and explicit refresh;
- stale search labeling/filtering;
- `COMMERCE_VERIFIED` never rendered as reputation/quality endorsement;
- Handoff search uses exact KTH `destination_type` vocabulary;
- Direct A2A remains usable without kiwi-catalog.

## 3. shopping-cli

- per-field authority/provenance;
- LOCAL_AUTHORITATIVE writes;
- UPSTREAM_PROXY_WRITE success/failure/idempotency/precondition;
- READ_ONLY mutation rejection;
- conflicting source authority → fail closed;
- ERP/local DB freshness;
- public/private boundary.

## 4. KTH/0.1

### Candidate

- Candidate JSON remains byte/content immutable after creation;
- lifecycle projection: PROPOSED → READY;
- lifecycle projection: PROPOSED/READY → STALE;
- rejected/expired;
- stale candidate cannot revive;
- replacement candidate links `supersedes_candidate_id`;
- lifecycle projection can be reconstructed from Ledger events.

### Candidate → Handoff

- same candidate/digest retry does not duplicate effect;
- same candidate/different digest fails closed;
- source candidate → CONSUMED only after successful delivery.

### Delivery state

- DELIVERED → LAUNCHED on local launch success;
- DELIVERED/LAUNCHED → OPENED_CONFIRMED only with explicit verifiable evidence;
- launch success without evidence never becomes OPENED_CONFIRMED;
- DELIVERED/LAUNCHED → EXPIRED;
- supported revocation → REVOKED;
- DELIVERED/LAUNCHED/OPENED_CONFIRMED never maps to order/payment success.

### Security

- unsafe scheme rejected;
- redirect destination revalidated;
- phishing/destination display policy;
- no secrets/private budget/merchant floor leakage.

## 5. E2E

```text
Buyer Kiwi
→ kiwi-catalog discovery
→ Direct A2A / KNP
→ AcceptedNonbindingAgreement
→ [selected_nonbinding OPTIONAL]
→ HandoffCandidate
→ approval
→ external checkout / PO / contact
```

At least one E2E must use shopping-cli-backed Merchant data and at least one must use an external-authority adapter.

## 6. Metrics

Verify emission of:

```text
agreement_to_handoff
handoff_launch_rate
opened_confirmed_rate
negotiation_to_handoff_rate (display: "Negotiation-to-Handoff Rate")
reported_external_conversion (explicitly non-authoritative unless integrated)
```


---

## 7. Product-first Discovery Tests

### Listing Contracts

- valid ProductListing;
- valid CapabilityListing;
- ProductListing stable `source_product_ref`;
- CapabilityListing does not require fake SKU;
- forbidden private fields rejected/stripped per contract;
- secret-like keys/values rejected;
- JSON depth/node/body limits.

### Publication

- owner auth;
- idempotent publish;
- same id/different content conflict semantics;
- withdraw;
- agent suspend/reject suppresses normal listing search;
- listing freshness independent from Agent freshness.

### Search

- q/category/region/listing_type filters;
- deterministic ranking;
- cursor pagination stable;
- search result contains owner agent and verification/freshness projections;
- `authority=discovery_projection`;
- `requires_direct_confirmation=true`.

### Source-of-Truth Boundary

- Catalog hint never becomes KNP Offer;
- availability hint never creates reservation;
- Buyer performs Agent/Card fresh verification before A2A;
- Merchant reply reads current CommerceDataSource facts.

### E2E

```text
Need
→ ProductIntent
→ /v1/listings/search
→ ProductListing
→ owner_agent_id
→ Agent Card fresh verify
→ Direct A2A
→ KNP Inquiry/RFQ
→ Offer
```
