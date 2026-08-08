---
title: shopping-cli Merchant Commerce Data & Operations Hub
version: "0.3"
date: 2026-08-07
status: Draft Product Architecture
---

# shopping-cli Merchant Commerce Data & Operations Hub v0.3

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
Handoff destination metadata (Kiwi Commerce v0.7.0+; exact KTH `destination_type` vocabulary)
```

kiwi-catalog indexes Agents; shopping-cli stores/aggregates commerce data.

shopping-cli MUST NOT publish a second `supports_*` naming system for the same destination capability.

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

Keep as Hosted/Legacy infrastructure with an explicit decision:

```text
- 存续原因：存量 hosted negotiation 链路仍在使用，且在 Direct A2A 上线并验证前没有替代通道
- 维护承诺：修复 claim escape / fake claim 等 P0 可靠性问题（主架构 rev1.5 §37），维持存量可用性
- 退役条件：Direct A2A + KiwiCatalogSource 验证通过后另行评估下线，不在 v0.7.0 范围内
```

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

`Handoff capabilities` and Handoff destination metadata are Kiwi Commerce v0.7.0+ integration points. The core CommerceDataSource / authority model can ship independently.

---

## 14. PublicListingProjection

为支持 Product-first Discovery，shopping-cli 增加只读/派生能力：

```text
projectProductListing(product_ref)
projectCapabilityListing(capability_ref)
listPublishableListings()
```

Projection 只能读取已授权 public 字段。

```text
Commerce Source of Truth
        ↓
PublicListingProjection
        ↓
Merchant Kiwi ListingDisclosurePolicy   # 入站发布披露 gate
        ↓
kiwi-catalog publish API
```

建议 ProductListing 输出：

```text
source_product_ref
title
category
brand?
public attributes
regions
commercial hints
source_revision
updated_at
fresh_until
```

不得输出：

```text
cost
floor price
private pricing rules
exact private inventory
credentials
customer-specific terms
```

`availability_hint` 与 `price_range_hint` 如果输出，必须带 freshness/source provenance，并明确只是 discovery hint。

## 15. Publication Sync

MVP 使用 push-first：

```text
source update
→ projection digest changes
→ Merchant Kiwi publishes/upserts Listing
```

商品删除/停止公开：

```text
→ withdraw Listing
```

Catalog 不反向进入 ERP 抓商品私有库。

## 16. v0.3 Definition of Done

1. 至少一种现有商品数据源能输出 ProductListing projection。
2. private fields 有回归测试确保不进入 projection。
3. projection 有 source_ref/source_revision/freshness。
4. 同内容 digest 不重复发布。
5. 商品停止公开可触发 withdraw。
6. Merchant Kiwi 可把 projection 发布到 kiwi-catalog v0.4。

> **实现载体（2026-08-08，shopping-cli v3.0 剥离后）**：#4/#5/#6 的发布面
> 由 **kiwi 仓 `merchant publish`** 承载（`src/product-publish.ts`）：
> 进程调用 shopping-cli 只读 `listings projections list --format json`
> 取 public-only 投影（projections 命令 v2.0 起提供、v3.0 保留），逐条
> 直连 kiwi-catalog `POST /v1/listings/publish`（服务端行级幂等：同
> `source_product_ref` upsert，digest 由服务端计算——同内容不重复建行）；
> reconcile 阶段对投影中消失的商品 `POST /v1/listings/{id}/withdraw`
> 实现 #5。shopping-cli 仓不再提供 publish/withdraw 子命令。

---

## 17. Revision History

- v0.2：解决 write-authority 歧义——每个 field/source 声明 `LOCAL_AUTHORITATIVE` / `UPSTREAM_PROXY_WRITE` / `READ_ONLY`，禁止把本地 shadow write 呈现为 upstream 成功（正文 §4/§5）。
- v0.2.1：Handoff 集成元数据统一使用 KTH `destination_type` 词汇，禁止第二套 `supports_*` 命名（正文 §8）。
- v0.3：新增 PublicListingProjection（§14）与 Publication Sync（§15），并更新 Definition of Done（§16）。
