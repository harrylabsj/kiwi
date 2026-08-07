---
title: kiwi-catalog 产品架构
version: "0.2"
date: 2026-08-07
status: Draft Product Architecture
---

# kiwi-catalog 产品架构 v0.2

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
verification_status
last_verified_at
fresh_until
```

Public data only.

## 7. Verification

States:

```text
DISCOVERED
PROFILE_VALID
DOMAIN_VERIFIED
AGENT_VERIFIED
COMMERCE_VERIFIED
STALE
SUSPENDED
REJECTED
```

Identity verification and commercial reputation remain separate.

`COMMERCE_VERIFIED` means only:

```text
the advertised commerce profile/capability set passed the configured protocol,
schema, namespace and identity checks at the recorded verification time
```

It MUST NOT be presented as:

```text
product-quality endorsement
merchant reputation rating
creditworthiness
recommended seller status
```

Commercial reputation remains a separate signal.

## 8. Search

Search by:

```text
merchant capability
category
region
A2A version
UCP capability
KNP support
Handoff capability (Kiwi Commerce v1.1+)
direct/hosted
verification freshness
```

kiwi-catalog SHOULD return candidates, not “guaranteed current truth”.

Kiwi performs task-time verification according to TrustPolicy.

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
11. stale profiles are excluded or visibly marked according to search policy.
12. refresh can be triggered by scheduled verification and by authorized explicit refresh.
13. refresh failures preserve the last verified snapshot but transition freshness/status appropriately.

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
