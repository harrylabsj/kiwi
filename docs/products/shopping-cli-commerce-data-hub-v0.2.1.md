---
title: shopping-cli Merchant Commerce Data & Operations Hub
version: "0.2.1"
date: 2026-08-07
status: Draft Product Architecture
---

# shopping-cli Merchant Commerce Data & Operations Hub v0.2.1

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

Kiwi Merchant-facing abstraction SHOULD split read, draft and write intent:

```text
searchProducts()
getProduct()
getInventory()
getPrice()
getDelivery()
getAfterSales()
getPublicListing()

draftProductChange()
draftInventoryChange()

applyProductChange()
applyInventoryChange()
```

`apply*` is not universally available.

Every field/source MUST expose a write mode:

```text
LOCAL_AUTHORITATIVE
UPSTREAM_PROXY_WRITE
READ_ONLY
```

Rules:

- `LOCAL_AUTHORITATIVE` — shopping-cli may write its own authoritative local field after normal policy/approval checks.
- `UPSTREAM_PROXY_WRITE` — shopping-cli may only call the authoritative source adapter; adapter authentication, scope, idempotency, optimistic concurrency/preconditions and approval MUST succeed.
- `READ_ONLY` — mutation MUST fail closed; shopping-cli MUST NOT update a local shadow copy and pretend the authoritative source changed.

A draft operation never changes the authoritative source.

## 5. Authority and Conflict Model

For each material field, source authority MUST be explicit.

Example:

```text
inventory   → ERP           → UPSTREAM_PROXY_WRITE or READ_ONLY
price       → pricing system→ UPSTREAM_PROXY_WRITE or READ_ONLY
description → PIM           → UPSTREAM_PROXY_WRITE or READ_ONLY
delivery    → shopping-cli  → LOCAL_AUTHORITATIVE
```

shopping-cli MUST NOT silently merge conflicting authoritative sources.

A normalized record SHOULD carry provenance:

```text
field
value
authority_source
source_revision / etag / version
observed_at
fresh_until
write_mode
```

If two configured sources both claim authority for the same field and policy does not define precedence:

```text
→ authority_conflict
→ fail closed / operator review
```

When `UPSTREAM_PROXY_WRITE` is used, local state becomes a cache/projection of the upstream result, not the transaction authority.

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

## 7A. Non-Responsibilities

shopping-cli is not:

```text
Commerce Agent identity authority
kiwi-catalog
mandatory Agent relay
KNP protocol authority
Buyer private-memory store
universal product/price authority when an upstream source is configured
order/payment/refund authority unless a future explicit adapter delegates such authority
```

When an external ERP/PIM/pricing/inventory system is configured as authority, shopping-cli is a normalized access/proxy layer, not the owner of that fact.

## 8. Relationship to kiwi-catalog

shopping-cli does not publish every SKU into kiwi-catalog.

Instead Merchant Kiwi may publish coarse public discovery metadata:

```text
merchant categories
regions
capabilities
Agent Card
UCP Profile
Handoff destination metadata (Kiwi Commerce v1.1+; exact KTH `destination_type` vocabulary)
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

---

## 13. Version Scope

`Handoff capabilities` and Handoff destination metadata are Kiwi Commerce v1.1+ integration points. The core CommerceDataSource / authority model can ship independently.

---

## 14. Review Closure

v0.2 resolves the write-authority ambiguity by making every field/source declare `LOCAL_AUTHORITATIVE`, `UPSTREAM_PROXY_WRITE`, or `READ_ONLY`, and by forbidding local shadow writes from being presented as upstream success.


---

## 15. v0.2.1 Consistency Patch

Handoff integration metadata now uses the exact KTH `destination_type` vocabulary. shopping-cli MUST NOT publish a second `supports_*` naming system for the same destination capability.
