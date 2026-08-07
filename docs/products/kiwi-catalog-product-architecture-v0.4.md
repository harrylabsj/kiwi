---
title: kiwi-catalog Product-first Commerce Discovery Architecture
version: "0.4"
date: 2026-08-07
status: Draft Product Architecture — Upgrade from implemented v0.3 baseline
implemented_baseline: FEATURES.md (2026-08-07, 66 passed / 5 skipped)
---

# kiwi-catalog 产品架构 v0.4

## 0. Upgrade Position

v0.4 不推翻现有 Agent Catalog。

当前已经实现的 Agent 注册、验证、Agent Card/UCP 抓取、三正交状态域、治理、幂等、限流、持久验证队列、SSRF-safe fetcher 和 `/v1/agents/*` API 全部继续作为基础设施底盘。

v0.4 新增的是 **Product-first Commerce Discovery**：

```text
Need
  ↓
Product / Service Intent
  ↓
ProductListing / CapabilityListing search
  ↓
Merchant Agent candidate
  ↓
Agent fresh verification
  ↓
Direct A2A
  ↓
Authoritative Inquiry / RFQ
```

因此产品定位从：

> Commerce Agent Catalog

升级为：

> **Commerce Discovery Catalog — 用商品/服务/供给能力找到可直接通信的 Commerce Agent。**

产品名仍然是 `kiwi-catalog`。

**v0.4 是 Kiwi Commerce v1.1 的一个里程碑**：主架构基线 rev1.5 §42 CD #22–28 与本文 DoD（§21）同构覆盖 kiwi-catalog 部分；实现验收以本文 DoD 为基线，v1.1 发布复核以主文档 CD 为准。

---

## 1. Core Principle

用户通常知道：

```text
我要什么
```

而不知道：

```text
应该找哪个 Merchant Agent
```

kiwi-catalog 的任务是把这两个世界连接起来：

```text
Human mental model
= product / service / capability

Agent network model
= Merchant Agent / A2A endpoint
```

一句话：

> **kiwi-catalog = 找到“谁可能有我要的东西”。**

---

## 2. Four Searchable Public Entities

v0.4 公开搜索域包含：

```text
Agent
Merchant
ProductListing
CapabilityListing
```

其中 Agent / Merchant 延续现有实现；新增 Listing 域。

### 2.1 ProductListing

表示一个 Merchant 愿意公开给 Agent 网络发现的具体商品/型号/SKU 搜索投影。

它不是商品主数据。

### 2.2 CapabilityListing

表示 Merchant 可以提供的供给/制造/服务能力，即使没有固定 SKU。

例如：

```text
10–32 inch industrial touch display manufacturing
MOQ >= 100
customization = yes
IP rating up to IP67
region = China
```

这对 B2B / 工业品 / 定制采购尤其重要。

---

## 3. Source of Truth Boundary

必须冻结以下边界：

```text
shopping-cli / ERP / PIM / Merchant DB
= Commerce Source of Truth

kiwi-catalog Listing
= Public Search Projection
```

因此：

```text
Catalog Listing != Offer
Catalog price_hint != negotiated price
Catalog availability_hint != inventory reservation
Catalog freshness != transaction guarantee
```

Buyer 在真正询价前 MUST 直接联系 Merchant Agent 获取当前事实。

---

## 4. ProductListing Model

建议逻辑模型：

```text
listing_id
listing_type = product
owner_agent_id
merchant_id
source_product_ref
source_revision?
title
summary?
category
brand?
attributes{}
regions[]
tags[]
commercial_hints{}
handoff_destination_types[]?
listing_digest
publication_state
freshness_state
published_at
updated_at
fresh_until
```

### 4.1 commercial_hints

允许公开的提示 MAY 包含：

```text
moq
price_range_hint
availability_hint
lead_time_hint
supports_bulk_quote
supports_customization
fulfillment_regions
```

这些都是 discovery hints，不是 KNP Offer。

### 4.2 Forbidden Fields

Listing MUST NOT 包含：

```text
merchant cost
floor price
exact private inventory
private pricing rule
customer-specific discount
credential / token / key
private customer data
private Principal Memory
```

---

## 5. CapabilityListing Model

建议逻辑模型：

```text
listing_id
listing_type = capability
owner_agent_id
merchant_id
title
summary
category
capability_attributes{}
regions[]
tags[]
commercial_hints{}
listing_digest
publication_state
freshness_state
published_at
updated_at
fresh_until
```

CapabilityListing SHOULD NOT invent a fake SKU.

Buyer 对 CapabilityListing 可先发 `Inquiry`；只有在 KNP 当前 item schema 可以无歧义表达需求时才直接发 RFQ。v0.4 不为 Listing 强行修改 KNP/1.0 wire schema。

CapabilityListing 不携带 `handoff_destination_types`（对比 ProductListing §4）：无 SKU 投影时，可用的交接目的地由 Direct A2A 阶段按实际 Inquiry/RFQ 结果确定。

---

## 6. Listing Publication Flow

首选 publish 模式：

```text
ERP / Local DB / PIM
       ↓
shopping-cli CommerceDataSource
       ↓
PublicListingProjection
       ↓
Merchant Kiwi ListingDisclosurePolicy   # 入站发布披露 gate；Buyer 出站披露沿用 NetworkDisclosurePolicy（主架构 rev1.5 §29）
       ↓
kiwi-catalog
```

也允许 Merchant Agent 自己发布 CapabilityListing。

### 6.1 Publication Rules

发布 MUST：

```text
be authenticated to owner_agent_id
be public-only allowlisted
be idempotent
carry source_product_ref (ProductListing MUST; CapabilityListing MAY)
carry source_revision when available
carry freshness metadata
pass size/depth/secret scanning
```

Merchant 可以只发布完整商品库中的一个子集。

---

## 7. Listing Lifecycle

使用两个正交状态域。

### 7.1 PublicationState

```text
ACTIVE
WITHDRAWN
SUSPENDED
```

- `ACTIVE`：可被发现；
- `WITHDRAWN`：publisher 主动下架；
- `SUSPENDED`：catalog governance 处置。

### 7.2 ListingFreshnessState

```text
FRESH
STALE
```

Listing freshness 与 Agent freshness 分开。命名约定：Agent 域状态为 `AgentFreshnessState`（FRESH/STALE/UNREACHABLE），Listing 域为 `ListingFreshnessState`（FRESH/STALE）。

可能出现：

```text
Agent = COMMERCE_VERIFIED + FRESH
Listing = STALE
```

这只表示 Agent 仍在线，但商品投影需要重新确认。

**STALE 判定（MVP 闭环保底）**：

```text
fresh_until < now  →  STALE    # on-read 惰性判定，无后台进程
```

- publish/upsert 成功刷新 `fresh_until` → FRESH；
- STALE Listing 在默认搜索中降权/显式标注，可由 query 过滤；
- publisher 可自查过期项（`GET /v1/agents/{agent_id}/listings?freshness_state=STALE`）并重发布；
- catalog 不建立到 publisher 的主动推送通道（保持 push-first 单向）。

---

## 8. Search API

保留现有：

```text
GET /v1/agents/search
```

新增：

```text
GET /v1/listings/search
GET /v1/listings/{listing_id}
GET /v1/agents/{agent_id}/listings
```

建议 query：

```text
q
listing_type
category
brand
region
tag
attribute filters
min_moq / max_moq
supports_bulk_quote
supports_customization
publication_state
freshness_state
agent_verification_level
agent_freshness_state
handoff_destination_type
cursor
```

v0.4 SHOULD 先复用现有 SQLite + deterministic filtering/ranking/cursor 基础，不以向量数据库作为上线前置条件。

语义/vector search MAY 作为后续增强。

---

## 9. Search Result Contract

Listing 搜索结果必须同时返回“商品/能力”和“谁可以被联系”：

```text
listing
merchant
agent
listing_freshness_state
match/reason fields
authority = discovery_projection
requires_direct_confirmation = true
```

示例：

```json
{
  "listing_id": "lst_01...",
  "listing_type": "product",
  "title": "21.5 inch Industrial Touch Display",
  "category": "industrial-display",
  "commercial_hints": {
    "moq": 50,
    "availability_hint": "in_stock",
    "supports_bulk_quote": true
  },
  "merchant": {
    "merchant_id": "m_01...",
    "display_name": "Example Display Co."
  },
  "agent": {
    "agent_id": "agt_01...",
    "verification_level": "commerce_verified",
    "freshness_state": "fresh"
  },
  "listing_freshness_state": "fresh",
  "authority": "discovery_projection",
  "requires_direct_confirmation": true
}
```

---

## 10. Product-first Buyer Flow

```text
User Need
  ↓
Buyer Kiwi ProductIntent
  ↓
GET /v1/listings/search
  ↓
shortlist ProductListing / CapabilityListing
  ↓
resolve owner_agent_id
  ↓
GET /v1/agents/{id} / fresh verify
  ↓
Agent Card → current A2A endpoint
  ↓
Direct A2A
  ↓
Merchant Kiwi
  ↓
shopping-cli / ERP current facts
  ↓
KNP Inquiry / RFQ / Offer
```

关键原则：

> **Catalog 负责召回；Merchant Agent 负责确认。**

---

## 11. Direct A2A Resolution

Listing MUST point to stable `owner_agent_id`，而不是复制一份 A2A endpoint 作为 Listing authority。

Buyer：

```text
listing.owner_agent_id
  ↓
current Agent record
  ↓
Agent Card URL
  ↓
fresh Agent Card
  ↓
supportedInterfaces
  ↓
current A2A endpoint
```

因此 endpoint 变化不需要重写所有 Listing。

---

## 12. Ranking Principles

MVP 排序建议优先级：

```text
1. hard filter satisfaction
2. category / attribute / query match
3. listing freshness
4. agent verification/freshness policy
5. deterministic tie-breaker
```

Commercial reputation MUST NOT 被隐藏混入 verification score。

付费推广如果未来存在，必须显式标识，不能伪装成自然排序质量。

---

## 13. New API Write Surface

建议：

```text
POST /v1/listings/publish
POST /v1/listings/bulk-publish      # MAY defer after single publish
POST /v1/listings/{id}/withdraw
POST /v1/listings/{id}/reinstate    # publisher/governance policy
```

继续复用当前：

```text
owner token semantics
write idempotency table
per-actor rate limit
per-domain protection
request body size limit
audit_events
```

不新造第二套认证/幂等系统。

---

## 14. Data Model Upgrade

在现有 13 张表基础上新增最小 Listing 域：

```text
commerce_listings
listing_public_snapshots   # optional if history/audit needs separate snapshot
```

MVP 可先把公开 attributes / regions / tags / commercial_hints 作为 canonical JSON 存入 `commerce_listings`，避免过早拆成大量 EAV 表。

建议唯一性：

```text
ProductListing:      (owner_agent_id, listing_type, source_product_ref)
CapabilityListing:   (owner_agent_id, listing_type, publisher_listing_key)
```

- ProductListing 的 `source_product_ref` 必填；
- CapabilityListing 使用 publisher-supplied stable external key，落地为升级计划 §3 的 `publisher_listing_key` 列（提供时幂等成立，缺省按 id 幂等）。

---

## 15. Freshness and Synchronization

Listing 更新采用 push-first：

```text
Merchant data changes
  ↓
PublicListingProjection changes
  ↓
publish/upsert digest
  ↓
kiwi-catalog
```

不是 kiwi-catalog 主动进入 Merchant ERP 抓私有商品库。

对于价格/库存高频变化，Merchant MAY 只发布粗粒度 hint；权威值仍在 Direct A2A 时读取。

### 15.1 Freshness 闭环

```text
publish/upsert  →  fresh_until = now + publisher TTL  →  FRESH
fresh_until < now（on-read 惰性判定）  →  STALE  →  search 降权/可过滤
publisher 自查 GET /v1/agents/{agent_id}/listings?freshness_state=STALE → 重发布 → FRESH
```

TTL 由 publisher 声明；无声明时服务端默认：ProductListing 24h，CapabilityListing（粗粒度 hint）7d（可配置）。refresh webhook（catalog → publisher 主动通知）作为后续增强 MAY。

---

## 16. Relationship to Existing Agent Catalog

现有 Agent 域不变：

```text
/v1/agents/*
verification ladder
three orthogonal state domains
profile fetcher
claim/suspend/reinstate
hosted Agent Card/UCP
```

新增 Listing 是上层 discovery index，不修改 Agent verification 语义。

---

## 17. Relationship to shopping-cli

```text
shopping-cli
= Product / SKU / Inventory / Price / Delivery Source of Truth Adapter

PublicListingProjection
= merchant-approved public search view

kiwi-catalog
= searchable projection index
```

shopping-cli SHOULD 提供 projection/export 接口，但 Catalog 不依赖 shopping-cli 才能存在；其他 Merchant runtimes 也可自己产生 Listing。

---

## 18. Relationship to KNP

KNP 仍负责真正的商业协商。

```text
Listing
  ↓
not authoritative
  ↓
Direct A2A
  ↓
Inquiry / RFQ
  ↓
Offer
```

KNP/1.0 不因 v0.4 Listing 自动增加订单、支付或库存副作用。

ProductListing 有公开 `source_product_ref` 且能映射到 Merchant KNP item/SKU 时，Buyer MAY 用该 reference 构造 Inquiry/RFQ。

CapabilityListing 不要求虚构 SKU。

---

## 19. Security

新增 Listing 面继承当前安全底盘，并补：

```text
public-only field allowlist
secret-like key/value scan
JSON depth/node/size bounds
owner_agent_id authorization
listing write idempotency
publication rate limiting
malicious keyword/HTML neutralization
no remote prompt execution
```

Listing 的标题、summary、attributes 同样属于 untrusted remote content。

---

## 20. v0.4 Implementation Phases

### Phase A — Listing Domain

```text
migration
repository/service
ProductListing
CapabilityListing
public-only serializer
publication lifecycle
```

### Phase B — Publish API

```text
publish
withdraw
owner auth
idempotency
rate limit
audit
```

### Phase C — Search

```text
/v1/listings/search
structured filters
deterministic ranking
cursor pagination
agent join/projection
freshness labels
```

### Phase D — Merchant Publication

```text
shopping-cli PublicListingProjection
Merchant Kiwi disclosure gate
incremental upsert/withdraw
```

### Phase E — Buyer Integration

```text
ProductIntent
listing search
shortlist
agent resolution
fresh verify
Direct A2A Inquiry/RFQ
```

---

## 21. v0.4 Definition of Done

1. Existing Agent Catalog APIs remain backward compatible.
2. Existing verification/security tests remain green.
3. ProductListing and CapabilityListing have frozen public contracts.
4. Listing contains no private Merchant fields.
5. Listing has owner_agent_id and can resolve to current Agent Card.
6. ProductListing supports stable source_product_ref when available.
7. CapabilityListing does not require a fake SKU.
8. `/v1/listings/search` supports q/category/region/type and cursor.
9. Search result clearly says `authority=discovery_projection`.
10. Search result says `requires_direct_confirmation=true`.
11. Listing freshness is independent from Agent freshness.
12. Agent suspension/rejection suppresses owned Listings from normal search (via search join exclusion) and governance marks them SUSPENDED — both, not either/or.
13. Listing publish reuses owner auth/idempotency/rate-limit/audit infrastructure.
14. Merchant can withdraw a Listing.
15. shopping-cli can generate at least one PublicListingProjection.
16. Buyer Kiwi can search a product and resolve the Merchant Agent.
17. Buyer revalidates Agent/Card before Direct A2A.
18. Direct Merchant Inquiry/RFQ uses authoritative Merchant-side data.
19. Catalog hint is never treated as Offer/inventory reservation.
20. One E2E passes: Need → Listing Search → Merchant Agent → Direct A2A → Offer.
21. Listing `fresh_until` 到期后自动判为 STALE（on-read 惰性判定，无后台进程），可从搜索降权/过滤，publisher 可自查并重发布。

---

## 22. Product Positioning After v0.4

```text
kiwi-catalog
= Agent-native Commerce Discovery Engine
```

它索引商品和能力，但**不成为商品数据库 authority**。

最终口径：

```text
kiwi-catalog
= 谁可能满足我的需求

A2A
= 找到以后怎么直接通信

shopping-cli
= 商家当前真正有什么

KNP
= 怎么谈

KTH
= 谈妥后去哪成交
```

---

## 23. Cold Start

kiwi-catalog 是双边网络（Merchant 发 Listing、Buyer 搜索），MVP 阶段必须显式播种首轮 Listing：

```text
种子来源（按优先级）：
1. shopping-cli 内置 demo/示例 Merchant（开发与演示用，明确标注非真实商家）
2. 自有真实供给数据（dogfooding，跑通真实发布链路）
3. 邀请 1–2 个真实 Merchant 手动发布少量真实商品（首批真实数据）

冷启动成功标准：≥20 条真实/半真实 ProductListing + 至少 1 条 CapabilityListing 在搜索中可召回，
且 Buyer → Merchant 询价链路在种子数据上全通。
```

不做虚假繁荣：种子 Listing 必须真实可询价（或明确标注 demo），不允许空壳 Listing 撑数量。
