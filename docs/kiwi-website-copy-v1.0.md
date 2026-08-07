# Kiwi 官网文案

version: "1.0"
date: 2026-08-07
status: Draft Copy
scope: Homepage, Buyer page, Merchant page, Developer page — 按 product-strategy rev1.2 §14/§15/§17 口径
对照文档：`docs/kiwi-product-layer-refactor-rev1.2.md`（§14 网站呈现、§15 对外叙事、§17 命名）

**文案纪律**（rev1.2 §14）：
- 官网第一屏**只给两个入口**：For Buyers / For Merchants；
- 不在第一屏出现 shopping-cli / kiwi-catalog / KNP / A2A（Developer 页再解释）；
- 对外只说 Kiwi Buyer / Kiwi Merchant / Kiwi Network 三个名字；
- 诚实不夸大：不宣称"已验证跨供应商互操作"（协议层 audit 口径），
  不承诺替代订单/支付/履约系统（§16 原则 10）。

---

## 1. Homepage

### Meta

```
title: Kiwi — AI agents that buy and sell for you
description: Kiwi is an open agent commerce network. Install it, tell it what you
  need, and let agents find, negotiate with, and hand you off to real businesses.
```

### Hero

```
EN:
Kiwi.
Agents that buy and sell — for real businesses.

Tell Kiwi what you need. It finds the right seller, negotiates the
terms, and hands you off to the checkout you already trust.

[ For Buyers ]      [ For Merchants ]

中文：
Kiwi。
让 AI Agent 替你真实地买卖。

告诉 Kiwi 你要什么。它找到对的卖家、谈好条件、
把你安全地交到你已经信任的成交入口。
```

### 价值三段（首页下滑）

```
EN:

1. Buy from the network, not the noise.
   Kiwi searches products and capabilities across an open network of
   merchants — then connects you directly to the merchant agent that
   can actually deliver. No walled garden.

2. Negotiate like a professional buyer.
   Price, MOQ, lead time, customization. Kiwi handles inquiry, RFQ,
   counter-offer and conditional terms with real merchants —
   transparently, with your policy and approval in control.

3. Real transactions stay where they belong.
   Kiwi never pretends an agreement is an order. When you're ready,
   it hands off the agreed terms to the checkout, ERP, PO or contact
   you already use.

中文：
1. 从网络买，而不是从噪音里淘。
   Kiwi 在一个开放的商家网络上搜索商品与能力——然后直接连到
   真正能交付的商家 Agent。没有围墙花园。

2. 像专业采购一样谈判。
   价格、起订量、交期、定制。询价、RFQ、还价、条件报价——
   Kiwi 与真实商家透明地谈，你的策略与审批始终在控制中。

3. 真实成交留在它该在的地方。
   Kiwi 从不把"谈妥"假装成"下单"。你准备好时，它把谈好的条件
   安全地交给你在用的结账、ERP、采购单或联系人。
```

### Network 区块（信任）

```
EN:
Kiwi Network — open, operated, verifiable.
   Every merchant on the network publishes a verifiable public
   projection of what they sell and how to reach them. Buyer and
   merchant agents talk directly over open protocols. The network
   helps you discover; it never gets in the way of the deal.

中文：
Kiwi Network——开放、受运营、可验证。
   网络上的每个商家都发布可验证的公开投影：卖什么、怎么联系。
   Buyer 与 Merchant Agent 通过开放协议直接对话。
   网络帮你发现；绝不插足交易本身。
```

### 页脚信任行

```
EN:
Open source. Merchant data stays merchant-controlled.
The network is operated by Kiwi; enterprises can run their own.

中文：
开源。商家数据始终由商家掌控。
网络由 Kiwi 官方运营；企业可自建私有网络。
```

---

## 2. For Buyers

### Meta

```
title: Kiwi Buyer — Install Kiwi. Tell it what you need.
```

### Hero

```
EN:
Install Kiwi. Tell it what you need.

"我要采购 500 台 21.5 英寸工业触摸屏，要求 IP67，7 天内交货。"
— that's all it takes to start.

[ Get Kiwi ]

中文：
安装 Kiwi。告诉它你要什么。
——一句需求，就足以开始。
```

### Install

```
EN:
One command. One identity. Start with a sentence.

npm install -g @harrylabsj/kiwi
kiwi buyer init --agent-id <your-id>
kiwi buyer search "21.5 inch industrial touch display, IP67"

中文：
安装只需要一条命令（发布后）。Buyer 不需要安装其他任何东西。
```

### 怎么工作（4 步）

```
EN:
1. Tell Kiwi what you need — a product, a service, a capability.
2. Kiwi searches the network and shortlists merchants that could
   actually deliver.
3. Kiwi talks directly to each merchant agent: inquire, RFQ,
   negotiate price, MOQ, lead time and customization.
4. When terms are agreed, Kiwi hands you off to the real checkout,
   PO, ERP or contact — and records exactly what was agreed.

中文：
1. 告诉 Kiwi 你要什么——商品、服务或能力。
2. Kiwi 搜索网络，筛出真正可能交付的商家。
3. Kiwi 直接与每个商家 Agent 沟通：询价、RFQ、谈价格、
   起订量、交期与定制。
4. 谈妥后，Kiwi 把你交到真实的结账、采购单、ERP 或联系人——
   并记录谈妥了什么。
```

### 承诺 / 边界（诚实条款）

```
EN:
What Kiwi shows you is a discovery hint, not a final price.
   Prices, stock and delivery are confirmed directly with the merchant
   before you commit. Kiwi never places an order, authorizes a payment,
   or reserves inventory on your behalf.

中文：
Kiwi 展示的是发现线索，不是最终价格。
   价格、库存与交期在你承诺前会与商家直接确认。
   Kiwi 绝不替你下单、授权支付或预留库存。
```

### 适用人群

```
EN:
For individuals, procurement teams, and buyer agents who want one
consistent way to find suppliers and get real answers — without
trading one marketplace walled garden for another.

中文：
面向个人、采购团队与 Buyer Agent——用统一的方式找供应商、
拿到真实答复，而不是从一个围墙花园换到另一个。
```

---

## 3. For Merchants

### Meta

```
title: Kiwi Merchant — Install Kiwi Merchant. Connect your catalog.
```

### Hero

```
EN:
Install Kiwi Merchant. Connect your catalog.
Let buyer agents find you, talk to you, and buy from you.

[ Get Kiwi Merchant ]

中文：
安装 Kiwi Merchant。连接你的商品目录。
让 Buyer Agent 找到你、跟你谈、向你买。
```

### Install

```
EN:
One command. Data engine included.

npm install -g @harrylabsj/kiwi
kiwi merchant init --merchant-id <your-merchant> --name "Your Co." --auto-install
kiwi merchant publish --profile merchant.yaml --shopping-cli-db <db>

中文：
一条命令装 Kiwi；init 时数据引擎（shopping-cli）自动安装——
你不需要知道它是什么、装在哪。
```

### 怎么工作（4 步）

```
EN:
1. Install Kiwi + your commerce data engine (shopping-cli) — one
   setup, guided by `kiwi merchant init`.
2. Connect your catalog: local database, ERP, or PIM. Your real
   data stays yours; only what you approve becomes public.
3. Publish — `kiwi merchant publish` puts your public products and
   capabilities on the network, and verifies your agent is reachable.
4. A buyer agent finds you, asks, negotiates — and the deal lands in
   your checkout, ERP, or sales contact, exactly as you choose.

中文：
1. 安装 Kiwi + 你的商业数据引擎（shopping-cli）——一次引导式设置
   （`kiwi merchant init`）。
2. 连接商品目录：本地数据库、ERP 或 PIM。真实数据始终是你的；
   只有你批准的内容成为公开信息。
3. 发布——`kiwi merchant publish` 把你的公开商品与能力送上网络，
   并验证你的 Agent 可达。
4. Buyer Agent 找到你、提问、谈判——交易落在你选的结账、
   ERP 或销售联系人里，完全由你决定。
```

### 数据边界（信任）

```
EN:
Your catalog is your castle.
   Cost, floor price, private inventory and customer terms never
   leave your system. What the network sees is a public projection
   you approve — product facts, availability hints, service regions.

中文：
你的目录是你的城堡。
   成本、底价、私密库存与客户条款永不离开你的系统。
   网络看到的只是你批准的公开投影——商品事实、
   可用性提示与服务区域。
```

### 谁适合

```
EN:
For manufacturers, brands, distributors and B2B suppliers who want
buyer agents to find them directly — without ceding their catalog,
their data, or their checkout to another platform.

中文：
面向制造商、品牌方、分销商与 B2B 供应商——让 Buyer Agent 直接
找到你，而不必把目录、数据或结账交给另一个平台。
```

---

## 4. For Developers

### Meta

```
title: Kiwi for Developers — open protocols, honest boundaries
```

### 介绍

```
EN:
Kiwi is one product with three roles, built from four open pieces.

中文：
Kiwi 是一个产品、三种角色，由四块开放组件构成。
```

### 组件表

```
| 组件 | 角色 | 一句话 |
|---|---|---|
| Kiwi Runtime | 用户侧运行时 | Buyer Agent 或 Merchant Agent 的执行环境：A2A、谈判、策略、审批、账本、Handoff |
| shopping-cli | Merchant 数据引擎 | 商品/库存/价格/交期的本地事实层 + ERP/PIM 适配器；Merchant 数据的权威在商家侧 |
| kiwi-catalog | Kiwi Network 服务端 | 开放网络：Agent 注册/验证、ProductListing/CapabilityListing 发现索引、治理 |
| kiwi-spec | 协议规范 | KNP/1.0（成交前谈判）、KTH/0.1（安全交接）、listing 契约 |
```

### 协议真相（诚实区）

```
EN:
- Buyer and merchant agents talk directly over A2A — the network is
  discovery, never a relay.
- KNP/1.0 ends at a non-binding agreement. It creates no order,
  authorizes no payment, reserves no inventory.
- KTH/0.1 hands the agreed terms to a real external destination
  (checkout URL, PO draft, ERP, contact). "Opened" is not "paid".
- Cross-vendor interoperability is verified in our own test stacks;
  independent third-party interop evidence is still being gathered.

中文：
- Buyer 与 Merchant Agent 经 A2A 直接对话——网络只做发现，绝不中转。
- KNP/1.0 止于非绑定共识。不创建订单、不授权支付、不预留库存。
- KTH/0.1 把谈妥的条件交给真实外部目的地（结账 URL、采购单草稿、
  ERP、联系人）。"已打开"不等于"已支付"。
- 跨供应商互操作在我们的测试栈中验证；独立第三方互操作证据仍在积累。
```

### 代码与构建（普通用户安装见 For Buyers / For Merchants 页）

```
EN:
# Kiwi Runtime
git clone https://github.com/harrylabsj/kiwi
cd kiwi && npm install && npm run build && npm link

# shopping-cli（数据引擎；Merchant 用户由 init --auto-install 自动装）
git clone https://github.com/harrylabsj/shopping-cli
cd shopping-cli && pip install -e '.[api]'

# kiwi-catalog（Network 服务端，Operator/自建网络用）
git clone https://github.com/harrylabsj/kiwi-catalog
cd kiwi-catalog && pip install -e '.[api]'

中文：
普通用户安装见 For Buyers / For Merchants 页（发布后 npm 一条命令）；
本页是开发者的源码位置与构建方式。
```

### 文档导航

```
EN:
Read the protocol spec first (docs/protocol/…), then the architecture
baseline, then the product-layer plan. Don't trust the marketing page
for wire semantics — the spec is the authority.

中文：
先读协议规范（docs/protocol/…），再读架构基线，最后读产品层计划。
不要用市场文案代替 wire 语义——规范才是权威。
```

---

## 5. 命名与一致性备忘（内部）

```
对外（官网/市场）：
  Kiwi Buyer / Kiwi Merchant / Kiwi Network

工程内部（README/文档/CLI 提示）：
  Kiwi Runtime / shopping-cli / kiwi-catalog / kiwi-spec

一句话（§15）：
  Buyer: Install Kiwi.
  Merchant: Install Kiwi + shopping-cli.
  Network: Run by Kiwi.

禁止：
  - 官网第一屏出现 shopping-cli / kiwi-catalog / KNP / A2A；
  - "已验证跨供应商互操作"类表述（无第三方证据前）；
  - 暗示替代订单/支付/履约系统。
```
