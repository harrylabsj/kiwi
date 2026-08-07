---
title: kiwi-catalog 产品架构
version: "0.3"
date: 2026-08-07
status: Draft Product Architecture
---

# kiwi-catalog 产品架构 v0.3

## 1. Positioning

kiwi-catalog 是从 shopping-cli 中独立出来的产品：

> **Commerce Agent Catalog + Discovery & Verification Infrastructure**

它不是商品数据库，也不是交易平台。

## 2. Core Question

kiwi-catalog 回答：

> 有哪些商业 Agent？它们代表谁？会什么？在哪里？怎么连接？最近是否验证过？

## 3. Responsibilities

```text
Agent registration
Agent discovery/search
Agent Card indexing/cache
UCP Profile indexing/cache
capability index
identity/domain verification metadata
profile freshness
trust metadata
direct/hosted endpoint metadata
claim/suspension
audit
```

## 4. Non-Responsibilities

```text
product master data
inventory authority
price authority
merchant private strategy
Buyer private state
negotiation transcript authority
mandatory message relay
order/payment/refund
```

## 5. Discovery Sources

```text
self registration
hosted merchant publication
well-known discovery
admin-curated entries
future federation/import
```

## 6. Agent Record

Suggested logical record:

```text
catalog_agent_id
principal_type
merchant_id?
display_name
canonical_domain
agent_card_url
ucp_profile_url
protocols
capabilities
skills
hosting_mode
verification_level
freshness_state
administrative_state
last_verified_at
fresh_until
```

Public data only.

## 7. Verification, Freshness and Administrative State

kiwi-catalog MUST NOT collapse verification evidence, profile freshness, and administrative governance into one state machine.

It uses three orthogonal state domains.

### 7.1 VerificationLevel

```text
DISCOVERED
PROFILE_VALID
DOMAIN_VERIFIED
AGENT_VERIFIED
COMMERCE_VERIFIED
```

Meaning:

```text
DISCOVERED
= candidate metadata exists.

PROFILE_VALID
= Agent Card/UCP profile passed schema/basic semantic validation.

DOMAIN_VERIFIED
= configured domain-control evidence passed.

AGENT_VERIFIED
= Agent identity/auth evidence meets TrustPolicy.

COMMERCE_VERIFIED
= advertised commerce capabilities/protocol metadata passed configured
  protocol/schema/namespace/identity checks at the recorded verification time.
```

`COMMERCE_VERIFIED` MUST NOT be presented as:

```text
product-quality endorsement
merchant reputation rating
creditworthiness
recommended seller status
```

Verification transitions:

| Current | Evidence/Event | Next |
|---|---|---|
| DISCOVERED | valid profile | PROFILE_VALID |
| PROFILE_VALID | valid domain control | DOMAIN_VERIFIED |
| DOMAIN_VERIFIED | agent identity evidence satisfies policy | AGENT_VERIFIED |
| AGENT_VERIFIED | commerce capability verification succeeds | COMMERCE_VERIFIED |
| any level | material identity/profile evidence invalidated | recompute to the highest still-supported lower level |

Historical evidence remains auditable; lowering the current projection does not delete prior observations.

### 7.2 FreshnessState

```text
FRESH
STALE
UNREACHABLE
```

Transitions:

| Current | Event | Next |
|---|---|---|
| FRESH | TTL/fresh_until expires | STALE |
| FRESH | refresh succeeds | FRESH |
| STALE | refresh succeeds | FRESH |
| FRESH/STALE | configured consecutive refresh failures / network unreachable threshold | UNREACHABLE |
| UNREACHABLE | refresh succeeds | FRESH |
| UNREACHABLE | partial reachability without successful verification | STALE or UNREACHABLE per policy |

`UNREACHABLE` is a reachability/freshness fact, not a reputation judgment.

### 7.3 AdministrativeState

```text
ACTIVE
SUSPENDED
REJECTED
```

Transitions:

| Current | Administrative Event | Next |
|---|---|---|
| ACTIVE | temporary enforcement/manual suspension | SUSPENDED |
| SUSPENDED | authorized restore | ACTIVE |
| ACTIVE/SUSPENDED | final rejection under governance policy | REJECTED |

`REJECTED` is terminal for the current catalog record unless an explicit appeal/governance process creates a new administrative decision.

### 7.4 Combined Example

A single Agent may legitimately be:

```text
verification_level = COMMERCE_VERIFIED
freshness_state = STALE
administrative_state = ACTIVE
```

This means the Agent was previously verified, its profile is currently stale, and it is not administratively suspended.

Commercial reputation remains a separate signal outside these three domains.

## 8. Search

Search by:

```text
merchant capability
category
region
A2A version
UCP capability
KNP support
Handoff destination type (Kiwi Commerce v1.1+; exact KTH `destination_type` vocabulary)
direct/hosted
verification level
freshness state
administrative state
```

kiwi-catalog SHOULD return candidates, not “guaranteed current truth”.

Kiwi performs task-time verification according to TrustPolicy.

For Handoff discovery, canonical query/result vocabulary is:

```text
handoff_destination_types[]
```

Values are exact KTH `destination_type` enum values. kiwi-catalog MUST NOT create parallel aliases such as `supports_erp_handoff`.

## 9. API Direction

```text
GET  /v1/agents
GET  /v1/agents/{id}
GET  /v1/agents/search
POST /v1/agents/register
POST /v1/agents/{id}/refresh
POST /v1/agents/{id}/verify
POST /v1/agents/{id}/claim
```

## 10. Relationship to Kiwi

```text
Kiwi AgentDiscovery
   ├── KiwiCatalogSource
   ├── WellKnownSource
   ├── DirectConfigSource
   └── OtherRegistrySource
```

kiwi-catalog is optional infrastructure.

## 11. Relationship to shopping-cli

```text
kiwi-catalog
= Agent metadata / discovery

shopping-cli
= Merchant product / inventory / operational data
```

Merchant Kiwi may publish selected public Agent metadata to kiwi-catalog while keeping product/private data in shopping-cli or its ERP.

## 12. Open Network Principle

kiwi-catalog MUST NOT require both parties to use Kiwi Runtime.

Any compatible commerce Agent MAY be indexed if it can publish verifiable standards-compatible metadata.

## 13. MVP

1. Merchant Agent registration.
2. Agent Card fetch/validation.
3. UCP fetch/validation.
4. domain verification.
5. capability indexing.
6. search.
7. Kiwi `KiwiCatalogSource`.
8. Direct A2A handoff after discovery.
9. no mandatory message relay.
10. profile freshness has an explicit `fresh_until`/TTL rule.
11. `VerificationLevel`, `FreshnessState`, and `AdministrativeState` are stored separately.
12. stale profiles are excluded or visibly marked according to search policy.
13. refresh can be triggered by scheduled verification and by authorized explicit refresh.
14. refresh failures preserve the last verified snapshot but transition only the appropriate freshness/reachability projection.
15. state-transition tests cover all three orthogonal domains.

---

## 14. Freshness Model

A verification result is time-bounded.

At minimum store:

```text
last_verified_at
fresh_until
last_refresh_attempt_at
last_refresh_result
```

Search MUST distinguish:

```text
verified + fresh
verified + stale
unverified
unreachable
```

A stale entry may remain discoverable by policy, but MUST NOT be silently presented as currently verified.

---

## 15. Version Scope

Handoff capability indexing is a **Kiwi Commerce v1.1+** extension. It is not required for the first Agent Catalog foundation milestone.


---

## 16. v0.3 Consistency Patch

This revision:

- splits verification, freshness and administration into three orthogonal domains;
- adds transition tables for each domain;
- preserves `COMMERCE_VERIFIED` as protocol/capability verification only;
- derives Handoff discovery vocabulary directly from KTH `destination_type`.
