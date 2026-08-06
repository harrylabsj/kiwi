---
title: Kiwi Agent Commerce Network 愿景澄清
version: v1.0
date: 2026-08-06
status: Vision Clarification
---

# Kiwi Agent Commerce Network 愿景澄清 v1.0

## 0. 文档目的

本文用于澄清 Kiwi、shopping-cli 与开放 Agent Commerce Network 的长期愿景、产品边界和相互关系。

它不是实现规格，也不是协议规范。它回答的是几个最根本的问题：

1. Kiwi 最终是什么？
2. 用户为什么需要 Kiwi？
3. 商家为什么也需要 Kiwi？
4. shopping-cli 在整个网络中扮演什么角色？
5. Buyer Agent 与 Merchant Agent 如何相互发现和沟通？
6. 为什么 shopping-cli 不应该成为所有通信的必经中心？
7. 为什么未来不应该局限于 Kiwi ↔ Kiwi？
8. Kiwi、shopping-cli、A2A、UCP、KNP 五者最终如何拼成一个完整系统？

核心结论：

> **Kiwi 是代表真实经济主体长期行动的 Commerce Agent Runtime；shopping-cli 是 Commerce Agent Catalog 与 Hosted Commerce Infrastructure；A2A 负责通信，UCP 负责商业能力发现，KNP 负责交易前协商。五者共同构成一个开放的 Agent Commerce Network。**

---

# 1. 最终愿景

整个体系最直观的愿景可以概括为三句话：

### 第一

用户可以安装 Kiwi，拥有一个代表自己的 Buyer Agent。

### 第二

商家可以安装 Kiwi，拥有一个代表自己的 Merchant Agent。

### 第三

shopping-cli 部署后成为 Commerce Agent Catalog，让 Buyer Agent 与 Merchant Agent 能够发现彼此；发现和验证完成后，双方优先通过 Direct A2A 直接通信，并使用 KNP 进行询价、报价、还价和交易前协商。

对于不具备独立 Agent 部署能力的商家，shopping-cli 同时提供 Hosted Merchant 能力。

```text
User
 │
 ▼
Kiwi Buyer Agent
 │
 │ discovery
 ▼
shopping-cli
Commerce Agent Catalog
 │
 │ candidate + identity + capabilities
 ▼
Merchant Kiwi Agent
 │
 └──────── Direct A2A + KNP ────────┐
                                     │
Buyer Kiwi  ◄──────────────────────► Merchant Kiwi
```

这不是一个新的电商平台。

它更接近：

> **一个由用户 Agent、商家 Agent、开放协议和可选基础设施共同组成的商业 Agent 网络。**

---

# 2. Kiwi 是什么

Kiwi 的最终定位不是“购物聊天机器人”。

它是：

> **代表一个真实 Principal 长期行动的 Commerce Agent Runtime。**

Principal 可以是：

```text
个人用户
家庭
企业采购方
商家
品牌
供应商
```

Kiwi 的核心不是一次性回答问题，而是长期维护：

```text
身份
角色
记忆
偏好
约束
任务
策略
授权
审批
长期关系
```

因此 Kiwi 更像一个长期存在的数字商业代理人。

---

# 3. Buyer Kiwi：用户自己的购物 Agent

用户安装 Kiwi 后，可以创建：

```text
Kiwi Buyer Agent
```

它代表用户，而不是代表平台。

它可以长期保存和理解用户自己的：

```text
购物偏好
预算边界
品牌倾向
质量要求
配送要求
历史选择
购买周期
可接受替代
任务状态
长期记忆
```

这些信息首先属于：

> **principal-private state**

不会自动暴露给 Merchant Agent。

例如用户说：

> 帮我找一台 5000 元以内、适合编程、护眼、售后稳定的显示器。

Buyer Kiwi 可以：

```text
理解用户真实需求
      ↓
形成结构化约束
      ↓
查询 Commerce Agent Catalog
      ↓
找到相关 Merchant Agents
      ↓
搜索商品与能力
      ↓
比较候选
      ↓
发起 RFQ
      ↓
自动询价 / 议价
      ↓
汇总不同商家的结果
      ↓
向用户解释并推荐
```

如果用户授权长期任务，还可以持续跟踪价格、库存和新的供应商。

因此 Buyer Kiwi 的价值不是“搜索一次商品”，而是：

> **长期代表用户做商业判断和商业行动。**

---

# 4. Merchant Kiwi：商家的电商运营 Agent

同一个 Kiwi Runtime，也可以创建 Merchant 角色：

```text
Kiwi Merchant Agent
```

它代表：

```text
商家
品牌
供应商
企业销售部门
```

Merchant Kiwi 可以长期维护：

```text
商品目录
库存事实
配送规则
售后规则
价格策略
促销策略
议价规则
客户分层
销售目标
经营偏好
```

以及更敏感的私有数据：

```text
成本
底价
目标毛利
内部折扣边界
大客户条件
库存周转目标
特殊授权
```

例如商家告诉自己的 Kiwi：

> 这款产品正常售价 899 元，200 件以上可以谈，但不能低于 820；500 件以上需要人工确认。

当 Buyer Agent 发来：

> 200 件，7 天内交货，最低多少钱？

Merchant Kiwi 可以结合库存、成本、物流、当前政策和授权边界，形成：

```text
Offer
CounterOffer
ConditionalOffer
Clarification
Decline
HumanRequired
```

在授权范围内可以自动回复；超出权限则请求商家人工审批。

Merchant Kiwi 的本质是：

> **商家的长期数字销售与运营代理人。**

---

# 5. Buyer Kiwi 与 Merchant Kiwi 必须保持角色隔离

一个 Kiwi instance 代表一个固定 Principal Role。

不能把同一个 Agent 同时做成 Buyer 和 Merchant，因为双方天然拥有完全不同的私有信息和利益目标。

Buyer Kiwi 拥有用户预算、购买动机和偏好；Merchant Kiwi 拥有成本、底价、利润和库存策略。双方只交换被明确授权的公开商业信息。

这不仅是安全要求，也是 Agent Commerce 能成立的根本前提。

---

# 6. shopping-cli 的最终定位

shopping-cli 最终承担两个主要角色：

```text
Commerce Agent Catalog
+
Hosted Commerce Infrastructure
```

这两个角色必须区分。

---

# 7. 第一角色：Commerce Agent Catalog

Commerce Agent Catalog 解决的问题是：

> **去哪里找到合适的商业 Agent？**

例如 Buyer Kiwi 接到任务：

> 找三个可以供应 500 台工业显示器、支持华南配送、支持自动询价的商家。

它可以查询 shopping-cli，按 category、region、capability、protocol、verification 等条件检索。

shopping-cli 返回 Merchant Agents，以及它们的：

```text
Agent identity
Agent Card
UCP Profile
Capabilities
Protocol versions
A2A endpoint
Direct / Hosted mode
Verification status
Profile freshness
```

所以 shopping-cli 类似：

> **Agent 世界里的商业黄页 + Commerce DNS + Verification Directory。**

---

# 8. Catalog 不是身份权威

shopping-cli Catalog 的角色是：

```text
index
```

而不是：

```text
ultimate identity authority
```

Catalog 可以告诉 Buyer Kiwi 某个 domain 有一个 Merchant Agent，但 Buyer Kiwi 在真正建立关系之前，还应根据策略验证 domain、Agent Card、UCP Profile、capabilities、identity 和 freshness。

也就是说：

```text
Catalog
= 去哪里找

Domain / Agent identity
= 对方到底是谁
```

---

# 9. Discovery 不意味着 Routing

这是整个体系最重要的架构原则之一。

Buyer Kiwi 可以通过 shopping-cli 找到 Merchant Agent，但发现完成后，不应该默认所有通信继续经过 shopping-cli。

优先模式应该是：

```text
              shopping-cli
              Agent Catalog
                    │
              discovery only
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
    Buyer Kiwi           Merchant Kiwi
          │                   │
          └──── Direct A2A ────┘
```

也就是：

> **shopping-cli 帮双方找到彼此，但不强迫双方永远通过自己通信。**

这是 Kiwi 网络与传统中心化电商平台的重要区别。

---

# 10. Direct A2A 是开放网络的核心

当 Buyer Agent 和 Merchant Agent 完成 discovery 和 capability verification 后：

```text
Buyer Agent
      ↕
     A2A
      ↕
Merchant Agent
```

A2A 负责连接、Message、Task、Artifact、context 和异步生命周期。

KNP 负责：

```text
RFQ
Offer
CounterOffer
ConditionalOffer
Clarification
Decline
非绑定协议结果
```

所以：

```text
A2A
= 怎么说话

KNP
= 谈什么商业语义
```

双方不需要知道对方内部使用什么模型或 Runtime，只需要协议兼容。

---

# 11. 第二角色：Hosted Commerce Infrastructure

并不是所有商家都会自己维护 Server、Domain、HTTPS、A2A endpoint、Agent Card、UCP Profile 和 Agent runtime。

因此 shopping-cli 还有一个重要作用：

> **让没有技术能力独立部署 Agent 的商家，也能加入 Agent Commerce Network。**

最终会同时存在两类 Merchant Agent。

## Independent Merchant Agent

```text
Buyer Kiwi
      ↕
  Direct A2A
      ↕
Merchant Kiwi
```

shopping-cli 只负责 discovery。

## Hosted Merchant Agent

```text
Buyer Kiwi
      ↕
     A2A
      ↕
shopping-cli Hosted Gateway
      ↕
Merchant Agent
```

shopping-cli 可以提供 Agent runtime、Agent Card、UCP Profile、A2A endpoint、Conversation runtime、Negotiation Gateway、Human Review 和 Audit。

因此 shopping-cli 既是开放网络的目录，也是低门槛加入网络的托管入口。

---

# 12. 最终形成的三层结构

```text
┌─────────────────────────────────────┐
│          Principal Layer            │
│                                     │
│    Buyer                    Merchant│
│      │                         │     │
└──────┼─────────────────────────┼─────┘
       │                         │
       ▼                         ▼
┌─────────────────────────────────────┐
│            Kiwi Agent Layer         │
│                                     │
│ Buyer Kiwi  ◄── A2A + KNP ──► Merchant Kiwi
│                                     │
└──────────────────┬──────────────────┘
                   │
              Discovery
                   │
                   ▼
┌─────────────────────────────────────┐
│       shopping-cli Infrastructure   │
│                                     │
│ Commerce Agent Catalog              │
│ Verification                        │
│ Hosted Merchant Gateway             │
│ Legacy Compatibility                │
└─────────────────────────────────────┘
```

---

# 13. 五个核心组件的分工

## Kiwi

> **谁在替你行动。**

Kiwi 是 Agent Runtime。

## shopping-cli

> **去哪里找到商业 Agent，以及如何让不具备独立部署能力的商家加入网络。**

## A2A

> **Agent 之间怎么通信。**

## UCP

> **Agent / Business 具备什么 Commerce 能力。**

## KNP

> **买卖双方 Agent 怎么谈生意。**

最简洁的表达是：

```text
A2A
= 怎么通信

UCP
= 会什么商业能力

shopping-cli
= 去哪里找

KNP
= 怎么谈生意

Kiwi
= 谁在替你谈
```

---

# 14. 第一阶段可以是 Kiwi ↔ Kiwi

第一阶段最容易落地的是：

```text
Kiwi Buyer
↔
Kiwi Merchant
```

因为两端 runtime、协议版本、安全策略和测试环境都可控。

可以最快跑通：

```text
安装 Buyer Kiwi
      ↓
安装 Merchant Kiwi
      ↓
Merchant 注册 Catalog
      ↓
Buyer 搜索
      ↓
发现 Merchant Agent
      ↓
验证
      ↓
Direct A2A
      ↓
KNP Negotiation
```

这是第一条真正完整的 Agent Commerce E2E。

---

# 15. 长期绝不能局限于 Kiwi ↔ Kiwi

Kiwi 的长期目标不应该是建立一个只有 Kiwi 才能进入的封闭生态。

真正的目标应该是：

```text
Kiwi Buyer
↔
ANY compatible Merchant Agent
```

以及：

```text
ANY compatible Buyer Agent
↔
Kiwi Merchant
```

只要双方兼容 A2A、Commerce capability discovery 和 KNP，就可以互操作。

因此：

> **Kiwi 是参考实现和高质量 Runtime，而不是网络准入许可证。**

---

# 16. shopping-cli 也不应该只登记 Kiwi Agent

Commerce Agent Catalog 不应该成为 Kiwi Agent Catalog，而应该成为 Commerce Agent Catalog。

它可以登记：

```text
Kiwi
OpenClaw
企业自研 Agent
SaaS Merchant Agent
其他兼容 Agent Runtime
```

shopping-cli 只应该关心：

```text
你是谁？
你代表谁？
你在哪里？
你支持什么协议？
你有哪些 Commerce capabilities？
是否经过验证？
怎么连接？
```

而不是：

> 你是不是 Kiwi？

这样才能形成真正的网络效应。

---

# 17. 网络效应从哪里产生

当 shopping-cli 中 Merchant Agents 越来越多，Buyer Agents 会更愿意使用 Catalog。

而 Buyer Agents 越来越多，Merchant Agents 也会更愿意注册 Catalog。

```text
Buyer Agents
       ↘
     Commerce Agent Catalog
       ↗
Merchant Agents
```

这就是 Agent Commerce Network 的双边网络效应。

但它和传统平台不同：

> Catalog 可以产生网络效应，而不必控制所有通信和每一笔商业关系。

---

# 18. 为什么这个结构比传统电商平台更开放

传统平台往往是：

```text
Buyer
  ↓
Platform
  ↓
Merchant
```

而 Kiwi Agent Commerce Network 更接近：

```text
Buyer Principal
      ↓
Buyer Agent
      │
      │ open protocol
      ▼
Merchant Agent
      ↓
Merchant Principal
```

shopping-cli 是可选基础设施：

```text
discovery
verification
hosting
compatibility
```

而不是所有商业关系的唯一中间人。

因此：

> **网络可以有强大的基础设施，但不要求强制中心化。**

---

# 19. 当前范围仍是 Pre-Transaction Commerce

虽然长期愿景很大，但当前协议边界必须保持克制。

目前 Kiwi / KNP / shopping-cli 的核心仍然是：

```text
发现
搜索
比较
咨询
询价
报价
还价
条件协商
形成非绑定选择
```

当前不把 Order、Payment、Refund、Escrow、Inventory Reservation、Settlement 偷偷加入 negotiation 层。

原则是：

> **先让 Agent 真正会发现、理解、比较和谈生意，再扩展到真正交易。**

---

# 20. 一个完整的未来用户故事

用户对自己的 Kiwi 说：

> 帮我采购 500 台工业显示器，7 天内交货，优先找有华南库存、售后好的供应商。

Buyer Kiwi：

```text
读取用户历史偏好与企业采购约束
      ↓
形成 SearchIntent
      ↓
查询 Commerce Agent Catalog
      ↓
找到多个 Merchant Agents
      ↓
验证 Agent Card / UCP / capabilities
      ↓
筛选兼容 Agent
      ↓
分别 Direct A2A 发 RFQ
```

Merchant Agents 分别返回报价、交期和条件。

Buyer Kiwi 可以继续 CounterOffer、ConditionalOffer、Clarification，最后向用户汇报综合方案。

用户不需要逐家打开网站，也不需要重复描述需求和手工比较几十条消息。

---

# 21. 一个完整的未来商家故事

一家中小商家安装 Kiwi：

```text
kiwi init --role merchant
```

然后告诉自己的 Agent：

> 我卖工业显示器，常规订单可以自动报价；低于 15% 毛利必须让我确认；500 台以上必须人工确认。

Merchant Kiwi 建立商品能力、库存连接、配送规则、售后政策、授权边界和私有成本/底价，随后注册到 shopping-cli Commerce Agent Catalog。

以后来自不同 Buyer Agents 的产品咨询、库存咨询、交期咨询、RFQ、CounterOffer，都可以先由 Merchant Kiwi 处理。

商家只处理真正需要人的大额交易、异常条件、超权限折扣、特殊合同和争议。

Merchant Kiwi 不只是客服机器人，而是：

> **商家的数字销售和商业运营代理人。**

---

# 22. 最终目标不是“AI 帮人购物”

如果只把 Kiwi 理解成“AI 帮用户购物”，会把这个项目看小。

更大的目标是：

> **让每个经济主体都拥有自己的 Agent，然后让这些 Agent 在开放协议上形成新的商业网络。**

今天互联网连接的是：

```text
人 ↔ 网站
```

平台电商连接的是：

```text
消费者 ↔ 平台 ↔ 商家
```

Agent Commerce 可能连接的是：

```text
Principal
   ↓
Agent
   ↕
Agent
   ↓
Principal
```

这才是 Kiwi 最值得追求的方向。

---

# 23. 一句话定义

## Kiwi

> **An agent runtime for economic principals.**

代表真实经济主体长期行动的 Commerce Agent Runtime。

## shopping-cli

> **Commerce Agent Catalog + Hosted Commerce Infrastructure.**

商业 Agent 的发现、验证和托管基础设施。

## Kiwi Agent Commerce Network

> **An open commerce network where economic agents discover, communicate, negotiate and collaborate through open protocols.**

一个让真实经济主体的 Agent 能够通过开放协议相互发现、沟通、协商和合作的商业网络。

---

# 24. 最终愿景

最终我们希望看到的不是一个新的购物 App，也不是一个新的电商平台。

而是：

```text
每个人
每个家庭
每个企业
每个商家
```

都可以拥有自己的 Agent。

这些 Agent 可以：

```text
相互发现
验证身份
理解能力
交换商业意图
协商条件
建立长期关系
```

而底层不依赖某一个模型，也不依赖某一个中心化平台。

最终：

> **Kiwi 提供 Agent，shopping-cli 提供网络入口，A2A 提供通信，UCP 提供商业能力发现，KNP 提供协商语言。**

五者组合起来，形成：

# **Open Agent Commerce Network**

这就是 Kiwi 与 shopping-cli 升级完成后真正应该实现的愿景。
