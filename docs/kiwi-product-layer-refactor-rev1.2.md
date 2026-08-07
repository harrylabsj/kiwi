---
title: Kiwi 产品层重构与统一安装体验
version: "rev1.2"
date: 2026-08-07
status: Product Strategy Draft
doc_type: product-strategy
scope: Product hierarchy, installation experience, Buyer/Merchant packaging, Network positioning
---

> **文档身份**：本文档版本（rev1.x）独立于产品版本（当前 v0.6.0 released /
> v0.7.0 draft）——产品版本以 CURRENT-DOCS.md 与 git tag 为准，本文档只描述
> 产品层目标状态与实现计划。rev1.1 修订：补完成定义（§19）、publish 编排归属
> 决策（§4.5）、Agent Card 双生成模式（§4.4）、Network 联邦后续标注（§5）。

# Kiwi 产品层重构与统一安装体验

## 1. 重构目标

Kiwi 当前已经形成三个清晰的技术组件：

```text
Kiwi
shopping-cli
kiwi-catalog
```

从技术职责看，三者应该继续保持独立边界；但从用户视角看，不能把它们包装成三个彼此平行、需要用户分别理解的产品。

产品层应从：

```text
三个产品
Kiwi
shopping-cli
kiwi-catalog
```

重构为：

```text
一个主品牌：Kiwi

两种用户角色：
Kiwi Buyer
Kiwi Merchant

一个公共网络：
Kiwi Network
```

底层技术映射为：

```text
Kiwi Buyer
= Kiwi Runtime（Buyer role）

Kiwi Merchant
= Kiwi Runtime（Merchant role）
+ shopping-cli

Kiwi Network
= kiwi-catalog
```

一句话：

> **对用户是一个 Kiwi 产品体系；对工程和部署仍然是多个独立组件。**

## 2. 产品定位重构

### 2.1 Kiwi：唯一主品牌

Kiwi 是整个产品体系的唯一主品牌。

对外不再重点宣传：

```text
shopping-cli
kiwi-catalog
```

而重点宣传：

```text
Kiwi Buyer
Kiwi Merchant
Kiwi Network
```

Kiwi 的统一产品定义：

> **Kiwi 是一个开放的 Agent Commerce Runtime 和 Commerce Network，让 Buyer Agent 与 Merchant Agent 可以发现彼此、直接沟通、询价、协商，并安全进入真实成交系统。**

### 2.2 Kiwi Buyer

Kiwi Buyer 面向个人消费者、企业采购人员、Buyer Agent 与采购团队。

Buyer 用户只需要安装：

```text
Kiwi
```

不需要安装 shopping-cli 或 kiwi-catalog。

核心体验：

```text
用户提出需求
↓
Kiwi 理解 Product / Service Intent
↓
搜索 Kiwi Network
↓
找到 ProductListing / CapabilityListing
↓
解析 Merchant Agent
↓
Direct A2A
↓
询问 / RFQ / Negotiation
↓
Transaction Handoff
```

> **Buyer 用户只需要知道 Kiwi。**

### 2.3 Kiwi Merchant

Kiwi Merchant 面向商家、品牌方、工厂、服务商、渠道商和 B2B 供应商。

Merchant 实际需要安装：

```text
Kiwi
+
shopping-cli
```

其中：

```text
Kiwi
= Agent Runtime / A2A / KNP / Policy / Handoff

shopping-cli
= Merchant Commerce Data Engine
```

Merchant 安装后的逻辑：

```text
Kiwi Merchant
        │
        ├── A2A Server
        ├── Merchant Agent
        ├── Negotiation Engine
        ├── Policy / Approval
        ├── Ledger
        └── CommerceDataSource
                 │
                 ▼
            shopping-cli
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
      ERP     Local DB     PIM
```

从工程上是两个独立组件；从产品体验上，是一个 Merchant 产品。

## 3. 安装体验统一原则

### 3.1 Buyer：只安装 Kiwi

目标体验：

```bash
install kiwi
kiwi buyer start
```

首次运行也可以是：

```text
Welcome to Kiwi

How will you use Kiwi?

[1] Buyer
[2] Merchant
```

选择 Buyer 后自动完成：

```text
创建 Buyer Principal
初始化 Buyer Vault
连接默认 Kiwi Network
配置模型
完成
```

Buyer 不需要理解 kiwi-catalog、A2A endpoint hosting、shopping-cli 或 ERP adapter。

它只需要：

> **告诉 Kiwi 自己想买什么。**

### 3.2 Merchant：安装 Kiwi + shopping-cli

Merchant 的实际安装由两个组件构成：

```text
Kiwi
shopping-cli
```

但安装体验不能变成“先学 Kiwi、再学 shopping-cli、再手工连接”。

应该由 Kiwi 提供统一入口：

```bash
install kiwi
install shopping-cli

kiwi merchant init
```

`kiwi merchant init` 自动完成：

```text
检查 shopping-cli 是否存在
↓
初始化 Merchant Principal
↓
初始化 Merchant Commerce Data
↓
建立 Kiwi ↔ shopping-cli 连接
↓
配置公开 / 私有数据边界
↓
配置 A2A Server
↓
生成 Agent Card
↓
生成 UCP Profile
↓
准备 Catalog 发布
```

如果 shopping-cli 未安装：

```text
Kiwi Merchant requires shopping-cli.

Install now?
[Y/n]
```

因此技术上仍是 Kiwi + shopping-cli，但用户体验是一个 `Kiwi Merchant setup`。

## 4. Merchant 核心产品流程

### 4.1 创建 Merchant Profile

用户填写：

```text
商家名称
主营品类
官网 / Domain
地区
联系方式
企业简介
```

生成 Merchant Principal 与 Merchant Agent identity。

### 4.2 连接商品数据

Kiwi 引导 Merchant 选择：

```text
Local database
CSV / Excel
ERP
PIM
Existing shopping-cli database
Platform API
```

实际连接工作由 shopping-cli 完成。

Kiwi 只提供统一 UI / CLI：

```bash
kiwi merchant data connect
```

内部调用 shopping-cli adapter。

### 4.3 建立公开商品投影

Merchant 的真实数据包括：

```text
Products
SKUs
Inventory
Prices
Delivery
Private cost
Floor price
Internal warehouse
```

不会全部进入公共网络。

而是：

```text
shopping-cli
      ↓
PublicListingProjection
      ↓
DisclosurePolicy
      ↓
ProductListing / CapabilityListing
```

最终公开：

```text
商品标题
分类
公开属性
MOQ
价格区间 hint
availability hint
服务区域
定制能力
```

而不公开成本、底价、私有定价规则、精确私有库存、凭证和客户信息。

### 4.4 启动 A2A Merchant Agent

Merchant Kiwi 启动 A2A Server，本地可以监听：

```text
localhost:PORT
```

再通过 Cloudflare Tunnel、Reverse Proxy、VPS 或 Enterprise Gateway 暴露：

```text
https://merchant.example/a2a
```

同时生成：

```text
/.well-known/agent-card.json
/.well-known/ucp
```

**Agent Card / UCP 有两种生成模式（工程上必须区分，不能混为一谈）**：

```text
模式 A —— Merchant 自持（自建 A2A server 时）
  Kiwi Runtime A2AServer card() 本地生成
  /.well-known/agent-card.json + /.well-known/ucp 由 merchant 域名托管

模式 B —— Catalog 托管（无自持 server 时）
  kiwi-catalog /v1/hosted/agents/{id}/agent-card.json + /ucp
  catalog 服务代为托管发布面

Discovery 侧（KiwiCatalogSource → resolveViaCatalog）对两种模式同样
fresh verify：agent_card_url 指向哪里就拉哪里，候选元数据不被直接信任。
```

`kiwi merchant start`（模式 A）与 catalog hosted 托管（模式 B）在
`kiwi merchant publish` 的校验步骤中都必须通过同一套 Agent Card schema
（contracts/kiwi-catalog/1.0/agent-record.schema.json 的 agent_card_url
指向即可）。

### 4.5 发布到 Kiwi Network

Merchant 执行：

```bash
kiwi merchant publish
```

内部完成：

```text
校验 Agent Card
↓
校验 UCP Profile
↓
发布 ProductListing / CapabilityListing
↓
注册 Kiwi Network
↓
kiwi-catalog 验证
↓
Merchant Agent Online
```

最终用户看到：

```text
✓ Merchant Agent running
✓ A2A endpoint online
✓ Commerce data connected
✓ 126 listings published
✓ Kiwi Network registration complete
✓ Verification pending / verified
```

**编排归属决策（rev1.1 定死）**：

```text
编排层：kiwi 仓（统一入口，调两仓能力）
  kiwi merchant publish
    ├── 1. 确认/注册 owner Agent     → kiwi-catalog POST /v1/agents/register
    │                                  （owner_token = KIWI_CATALOG_OWNER_TOKEN_SECRET
    │                                   派生，算法与 kiwi-catalog api/auth.py 逐字节一致）
    ├── 2. 触发 listing 发布          → 进程调用 shopping-cli CLI
    │                                  （spawn `shopping listings publish-listings`，
    │                                   不建立 HTTP 强依赖——组件独立发布，§12 原则）
    └── 3. 汇总分步状态               → 解析 shopping-cli 报告 + kiwi-catalog 验证状态
                                        fail-closed：任一步失败不假装全成功
```

- **进程调用而非 HTTP 依赖**：保持三组件独立发布周期（§12）；kiwi 仓
  `kiwi merchant publish` 只在 shopping-cli 已安装时可用（缺失 → 引导安装，§3.2）；
- **失败语义**：分步报告（agent 注册成功 / listing 发布失败等逐项列出），
  任一关键步骤失败 → 非零退出 + 明确原因，不输出"全部成功"；
- **幂等**：重复 publish 是安全操作——agent 注册幂等（同 domain upsert）、
  listing 发布 digest 去重（shopping-cli 镜像表，DoD #4）。

## 5. kiwi-catalog 的产品角色

kiwi-catalog 不应该成为普通 Buyer 或 Merchant 需要理解的第三个产品。

它对外更适合品牌化为：

```text
Kiwi Network
```

技术实现：

```text
Kiwi Network
        ↓
kiwi-catalog
```

它负责：

```text
Agent registration
Agent verification
Merchant discovery
ProductListing search
CapabilityListing search
Freshness
Governance
Trust metadata
```

但不负责：

```text
商品 Source of Truth
实时库存
实时价格
Merchant 私有数据
A2A 消息转发
订单
支付
履约
```

> **kiwi-catalog 是公共网络基础设施，不是普通用户安装的软件。**

**Network 联邦（后续版本，rev1.1 标注）**：本文默认官方单一 kiwi-catalog
（Kiwi Network）。多网络联邦/多实例（架构基线中的 `FutureRegistrySource` 接缝）
属于后续版本——本轮产品层重构**不假设**联邦能力；企业自建 Private Kiwi Network
走同一部署物（kiwi-catalog Docker/systemd），网络间互操作留待未来协议工作。

## 6. Product-first 用户体验

产品层的核心入口不应该是 `Find Merchant`，而应该是：

```text
Tell Kiwi what you need
```

例如 Buyer 说：

> 我要采购 500 台 21.5 英寸工业触摸屏，要求 IP67，7 天内交货。

Buyer Kiwi：

```text
Need
↓
Product / Capability Intent
↓
Kiwi Network Search
↓
ProductListing / CapabilityListing
↓
Merchant Agent Candidates
↓
Direct A2A
↓
Authoritative Inquiry
↓
KNP RFQ / Offer
↓
Negotiation
↓
Handoff
```

因此：

> **商品是用户发现入口，Agent 是网络通信对象。**

## 7. 三层产品边界

### Layer 1 — User Product

```text
Kiwi Buyer
Kiwi Merchant
```

这是用户真正使用的产品。

### Layer 2 — Merchant Data

```text
shopping-cli
```

它是 Merchant 的 Commerce Data Engine。

可以独立开源、独立安装、独立升级。

但在产品体验中：

```text
shopping-cli
⊂ Kiwi Merchant
```

### Layer 3 — Network Infrastructure

```text
Kiwi Network
        ↓
kiwi-catalog
```

这是官方公共基础设施。

普通用户不安装。

企业用户可以自建 Private Kiwi Network / Private kiwi-catalog。

## 8. 最终产品架构

```text
                           KIWI

             ┌──────────────┼──────────────┐
             │              │              │
             ▼              ▼              ▼

         Kiwi Buyer     Kiwi Merchant   Kiwi Network
             │              │              │
             │              │              ▼
             │              │         kiwi-catalog
             │              │
             │              ▼
             │         shopping-cli
             │              │
             │        ERP / PIM / DB
             │
             └────── Direct A2A ──────┘
                       + KNP
                         │
                         ▼
                      Handoff
```

Buyer 与 Merchant 的 A2A 通信不经过 Kiwi Network。

Kiwi Network 负责 Discovery，不负责 Routing。

## 9. 安装矩阵

| 用户 | 安装 Kiwi | 安装 shopping-cli | 安装 kiwi-catalog |
|---|---:|---:|---:|
| Buyer | ✅ | ❌ | ❌ |
| Merchant | ✅ | ✅ | ❌ |
| Kiwi Network Operator | 可选 | ❌ | ✅ |
| Enterprise Private Network | 可选 | 可选 | ✅ |

最重要的安装规则：

```text
Buyer
= Kiwi

Merchant
= Kiwi + shopping-cli

Network
= kiwi-catalog
```

## 10. CLI 统一设计

虽然存在多个技术组件，对 Merchant 仍应提供统一的 Kiwi 命令入口。

建议：

```text
kiwi
├── buyer
├── merchant
├── network
└── doctor
```

Buyer：

```bash
kiwi buyer init
kiwi buyer start
kiwi buyer search
kiwi buyer tasks
```

Merchant：

```bash
kiwi merchant init
kiwi merchant start
kiwi merchant status
kiwi merchant publish
kiwi merchant listings
kiwi merchant doctor
```

商品数据：

```bash
kiwi merchant data status
kiwi merchant data import
kiwi merchant data connect
kiwi merchant data sync
```

这些命令内部可以代理到 shopping-cli，但用户不需要切换工具。

## 11. shopping-cli 的长期定位

shopping-cli 不建议取消。

它具有独立存在价值：

```text
开发者直接使用
ERP / DB adapter 独立测试
Merchant data 管理
本地数据运维
无 Kiwi Runtime 场景
```

GitHub 项目继续保留 `shopping-cli`。

但产品定位改成：

> **Kiwi Merchant Commerce Data Engine**

README 第一屏应说明：

```text
shopping-cli is the commerce data engine used by Kiwi Merchant.
```

而不是让用户误以为 shopping-cli 是和 Kiwi 并列竞争注意力的终端产品。

## 12. 仓库结构建议

保持多仓库：

```text
harrylabsj/kiwi
harrylabsj/shopping-cli
harrylabsj/kiwi-catalog
harrylabsj/kiwi-spec
```

原因：

```text
不同发布周期
不同部署方式
不同安全模型
不同数据责任
不同扩展方式
```

不要因为安装体验合一而做 monolithic repo / monolithic binary / monolithic release。

> **产品统一 ≠ 代码合并。**

## 13. 发布体系

### Kiwi

面对 Buyer 和 Merchant统一发布。

### shopping-cli

作为 Merchant 依赖，拥有自己的版本。

Kiwi Merchant 定义兼容范围：

```text
Kiwi x.y
supports shopping-cli >= a.b < c
```

### kiwi-catalog

作为 Kiwi Network 服务端，独立发布和部署。

Buyer / Merchant 通过稳定 API 契约使用它。

## 14. 网站与品牌呈现

官网第一屏不应该列：

```text
Kiwi
shopping-cli
kiwi-catalog
KNP
A2A
```

而应该只给用户两个入口：

```text
For Buyers
For Merchants
```

Buyer 页面：

> Install Kiwi. Tell it what you need.

Merchant 页面：

> Install Kiwi Merchant. Connect your catalog. Let Buyer agents find and talk to you.

开发者页面再解释 Kiwi Runtime、shopping-cli、kiwi-catalog、KNP 和 A2A。

## 15. 对外产品叙事

最终最简单的解释：

> **消费者安装 Kiwi，商家安装 Kiwi + shopping-cli。商家把公开商品和能力发布到 Kiwi Network。Buyer Kiwi 先通过 Kiwi Network 找到可能满足需求的商品和 Merchant Agent，然后直接通过 A2A 与 Merchant Kiwi 沟通和谈判。**

压缩成：

```text
Buyer:
Install Kiwi.

Merchant:
Install Kiwi + shopping-cli.

Network:
Run by Kiwi.
```

## 16. Product Principles

1. **One Brand** — 用户只需要理解 Kiwi。
2. **Two Roles** — Buyer / Merchant 是两个主要产品入口。
3. **One UX** — Merchant 底层需要 Kiwi + shopping-cli，但由 Kiwi 统一组织体验。
4. **Multiple Components** — 安装体验统一，不意味着代码和部署合并。
5. **Product-first Discovery** — 用户从“我要什么”开始，而不是从“我要找谁”开始。
6. **Direct Agent Communication** — Discovery 完成后，Buyer 与 Merchant 直接 A2A 通信。
7. **Merchant Data Stays Merchant-controlled** — shopping-cli / ERP 是经营事实 authority。
8. **Network Is Infrastructure** — kiwi-catalog 是 Kiwi Network 的基础设施。
9. **Open but Operated** — 软件可以开源，官方 Kiwi Network 仍由 Kiwi 官方运营。
10. **No Forced Platform Replacement** — Kiwi 优先解决发现、询价、协商和 Handoff，不要求先取代订单、支付和履约系统。

## 17. 推荐的最终产品命名

对外：

```text
Kiwi
├── Kiwi Buyer
├── Kiwi Merchant
└── Kiwi Network
```

工程内部：

```text
Kiwi Runtime
shopping-cli
kiwi-catalog
kiwi-spec
```

关系：

```text
Kiwi Buyer
= Kiwi Runtime / Buyer role

Kiwi Merchant
= Kiwi Runtime / Merchant role
+ shopping-cli

Kiwi Network
= kiwi-catalog
```

## 18. 最终产品定义

> **Kiwi 是一个开放的 Agent Commerce 产品体系。Buyer 只需安装 Kiwi；Merchant 安装 Kiwi 与 shopping-cli，并通过统一的 Kiwi Merchant 体验连接自己的商品、库存和 ERP。Kiwi Network 由 kiwi-catalog 提供公共发现与验证能力。Buyer 先通过商品或能力找到可能满足需求的 Merchant Agent，再与 Merchant Kiwi 直接 A2A 通信、询价和协商，最终通过 Transaction Handoff 进入真实成交系统。**

最终用户认知应当非常简单：

```text
我要买东西
→ 用 Kiwi

我要让 AI 帮我的商家做生意
→ 用 Kiwi Merchant

我要理解底层技术
→ 再去看 shopping-cli / kiwi-catalog / KNP / A2A
```

这就是 Kiwi 产品层重构后的目标状态。

---

## 19. 完成定义与验收（rev1.1 新增）

产品层重构按完成定义验收（沿用项目 CD/DoD + readiness audit 惯例），
不宣布"完成"直到逐条直接实证：

| # | 完成定义 | 验收标准 | 状态 |
| --- | --- | --- | --- |
| D0 | 统一 CLI 树可执行 | `kiwi buyer / merchant / network / doctor --help` 全部可用；现有 `kiwi agent serve` / `kiwi chat` 映射为 `merchant start` / `chat` 且保留别名兼容；CLI 骨架测试全绿 | ✅ 已实现（kiwi e1fe866） |
| D1 | `kiwi merchant init` 端到端 | 首次初始化完成：shopping-cli 依赖检测（缺失 → 引导安装提示）→ Merchant Principal/Vault → Kiwi↔shopping-cli 连接配置 → 公开/私有边界配置 → A2A Server 配置 → Agent Card/UCP 生成（模式 A 或 B）→ 可发布状态；E2E 测试（mock shopping-cli）通过 | ✅ 已实现（kiwi e1fe866）：profile 生成（agent_id = merchant_id 身份统一）+ 依赖检测 + 连接可达性 + 数据目录；Agent Card/UCP 由 `merchant start` 运行时生成（模式 A） |
| D2 | `kiwi merchant publish` 编排 | 一次命令完成：agent 注册（kiwi-catalog，owner token 派生）→ listing 发布（进程调用 shopping-cli，digest 去重）→ 分步状态汇总（fail-closed：任一步失败非零退出 + 明确原因）；编排 E2E（双 stub）通过 | ✅ 已实现（kiwi e1fe866）：三步编排 + 幂等（先查复用）+ 身份统一 + 版本门（D3 矩阵消费） |
| D3 | `kiwi doctor` 聚合健康 | 输出三组件状态：Kiwi runtime self-check + shopping-cli 存在性/版本（版本兼容矩阵 `Kiwi x.y supports shopping-cli >= a.b < c`）+ kiwi-catalog 可达性；矩阵有单一来源配置并被 doctor 与 publish 共同消费 | ✅ 已实现（kiwi e1fe866）：product-compat.ts 单一来源（>= 2.0.0 < 3.0.0），doctor 与 publish 共同消费 |
| D4 | `kiwi buyer` 命令面 | `buyer init / start / search / tasks` 可用：search 复用 Product-first 链路（ProductIntent → listing 搜索），start 为 chat TUI 入口；Buyer 不感知 shopping-cli / kiwi-catalog（§2.2） | ✅ 已实现（kiwi e1fe866 + kiwi-catalog 07bad01）：init/search/tasks + start 别名；search 复用 M3 链路；跨仓修复 merchants 影子表写入方 |

实施顺序（rev1.2 更新：D0–D4 已全部落地）：

```text
D0（CLI 骨架）→ D2（publish 编排）→ D1（merchant init）
→ D3（doctor 聚合 + 版本矩阵）→ D4（buyer 命令面）
全部完成；实现证据与真实 E2E 记录见
docs/reviews/kiwi-product-layer-readiness-audit-2026-08-07.md
```

明确不做（本轮）：

```text
CSV / PIM / Platform API adapter（保持 local + ERP 面）
Network 联邦 / 多网络互操作（§5 标注为后续版本）
monorepo / monolithic binary（§12 原则：产品统一 ≠ 代码合并）
官网与市场文案（品牌层，非工程侧）
```
