---
title: kiwi-catalog 产品架构
version: "0.1"
date: 2026-08-07
status: Product Architecture
---

# kiwi-catalog 产品架构 v0.1

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

## 8. Search

Search by:

```text
merchant capability
category
region
A2A version
UCP capability
KNP support
Handoff capability
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
