---
title: shopping-cli Merchant Commerce Data & Operations Hub
version: "0.1"
date: 2026-08-07
status: Product Architecture
---

# shopping-cli Merchant Commerce Data & Operations Hub v0.1

## 1. New Positioning

shopping-cli 不再承担 Commerce Agent Catalog。

新定位：

> **Merchant Commerce Data & Operations Hub**

它为 Merchant Kiwi 提供统一、可审计、可连接外部系统的商业事实层。

## 2. Core Data

```text
merchant
product
SKU
inventory
price
delivery
after-sales
listing metadata
public commerce policy
authorized business context
```

敏感成本、底价、私有客户政策仍受 Vault / private boundary 保护。

## 3. Data Sources

shopping-cli SHOULD support adapters for:

```text
local SQLite
Postgres / MySQL
ERP
PIM
CSV / Excel import
merchant internal REST API
inventory system
pricing system
platform API
```

## 4. Unified CommerceDataSource

Kiwi Merchant-facing abstraction:

```text
searchProducts()
getProduct()
getInventory()
getPrice()
getDelivery()
getAfterSales()
getPublicListing()
draftProductChange()
updateProduct()
updateInventory()
```

Write operations remain scope-controlled and approval-aware.

## 5. Authority

For each field, source authority MUST be explicit.

Example:

```text
inventory → ERP
price → pricing system
description → PIM
delivery → shopping-cli local rule
```

shopping-cli MUST NOT silently merge conflicting authoritative sources.

## 6. Sync

Adapters SHOULD support:

```text
pull
scheduled refresh
webhook/event ingestion when available
manual import
conflict detection
freshness timestamp
```

## 7. Public vs Private

Public Agent-facing data:

```text
product facts
public price
availability
delivery promise
after-sales policy
```

Private Merchant data:

```text
cost
floor price
margin target
internal customer segment
private automation boundary
credentials
```

## 8. Relationship to kiwi-catalog

shopping-cli does not publish every SKU into kiwi-catalog.

Instead Merchant Kiwi may publish coarse public discovery metadata:

```text
merchant categories
regions
capabilities
Agent Card
UCP Profile
Handoff capabilities
```

kiwi-catalog indexes Agents; shopping-cli stores/aggregates commerce data.

## 9. Relationship to KNP

During negotiation, Merchant Kiwi can read shopping-cli facts to construct Offer/CounterOffer/ConditionalOffer.

KNP remains the wire protocol.

shopping-cli is a data source, not KNP itself.

## 10. Legacy Hosted Negotiation

Existing:

```text
shopping.negotiation/0.1
claim
heartbeat
audit
authoritative policy gate
```

MAY remain as Hosted/Legacy infrastructure.

This does not restore Agent Catalog responsibility to shopping-cli.

## 11. Relationship to Transaction Handoff

shopping-cli MAY provide:

```text
public product URL
checkout URL template
ERP reference
quote metadata
SKU mapping
availability freshness
```

to the Handoff Engine.

It MUST NOT claim an external order/payment succeeded unless the authoritative external system reports it.

## 12. MVP Upgrade

1. Introduce `CommerceDataSource`.
2. Preserve current local database adapter.
3. Add one ERP adapter.
4. Add one generic local SQL adapter.
5. Add freshness/provenance per field.
6. Keep public/private serializers.
7. Expose Merchant Kiwi-compatible API.
8. Remove Agent Catalog responsibilities from product positioning and APIs.
