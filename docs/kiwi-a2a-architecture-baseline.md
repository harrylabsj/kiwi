---
title: Kiwi A2A Agent Commerce Network 总体架构基线
doc_revision: "1.2"
target_product: "Kiwi A2A v1.0"
date: 2026-08-05
status: Architecture Baseline
canonical_source: markdown
supersedes: "doc_revision 1.1"
scope: Pre-transaction Agent-to-Agent Commerce
---

# Kiwi A2A Agent Commerce Network 总体架构基线

## 0. 文档定位

本文是 Kiwi A2A 的总体架构母文档，也是后续子规范和 v0.4+ 实现工作的 canonical source。

Markdown 是唯一规范源；PDF 只能作为 Markdown 的导出物，不得成为独立事实源。旧 `kiwi_a2a_v1.md` / rev 1.1 PDF 在采用本文后应标记为 superseded。

本文回答：

- Kiwi 的产品和协议定位；
- 已实现能力与待实现能力的边界；
- A2A、UCP、Kiwi Negotiation 的职责分层；
- shopping-cli 在开放网络中的定位；
- Buyer Agent 与 Merchant Agent 的发现、连接、协商与恢复；
- 身份、信任、策略、审批、披露、幂等和反滥用；
- v1.0 的明确完成边界。

Wire-level JSON Schema、精确状态转换表、test vectors 和错误响应格式由：

```text
Kiwi Negotiation Protocol 1.0
```

定义。子规范 MUST 遵守本文的架构边界和安全不变量。

---

# 1. 当前实现状态

## 1.1 已实现并继承

当前 Kiwi 已经实现并继续作为 A2A 安全底盘：

```text
AgentKernel
Principal Memory
Private Vault
Main Chat Session
Isolated Task Session
Task Scheduler

Buyer:
  search
  rank
  track
  consultation
  negotiation
  selected_nonbinding

Merchant:
  catalog read
  inventory read
  business context
  private floor / cost vault
  write ActionCandidate

OperatorController

manual
supervised
autopilot

HardPolicy
SessionStrategy
TurnInstruction

Approval
Credential Broker

shopping-cli:
  claim
  heartbeat
  idempotency
  audit
  authoritative policy gate
```

## 1.2 已设计但尚未实现

```text
OpenClaw ACP-Runtime Adapter
Hermes ACP-Runtime Adapter
```

它们未来只是 `ReasoningBackend`，不是对外 A2A 协议。

---

# 2. Kiwi 的重新定义

Kiwi v0.3 是：

> 一个持续代表 Buyer 或 Merchant、拥有长期记忆、任务能力和私有策略的 Agent-first 电商运行时。

Kiwi A2A v1.0 在此基础上升级为：

> **一个开放的 Agent Commerce Runtime，使真实经济主体的 Buyer Agent 与 Merchant Agent 可以跨运行时、跨组织、跨平台直接发现、沟通、询价、报价、还价、澄清和形成非绑定商业共识。**

Kiwi 的长期核心资产：

```text
Principal Agent Runtime
+
Private Preference Model
+
Negotiation Intelligence
+
Negotiation Protocol
+
Trust / Policy / Approval
+
Open Interoperability
```

---

# 3. 协议分层

## 3.1 A2A

负责：

```text
Agent discovery
Agent Card
Message
Task
Artifact
contextId
streaming
authentication
protocol binding
```

回答：

> Agent 怎么和另一个 Agent 通信？

A2A 1.0 core protocol bindings 包括：

```text
JSONRPC
GRPC
HTTP+JSON
```

Kiwi MUST 从 Agent Card 的 `supportedInterfaces` 中选择双方共同支持的 binding，不得把某一种 binding 硬编码为 Kiwi 协议本身。

## 3.2 UCP

负责 Commerce capability discovery 和标准 Commerce 语义，包括标准能力如 catalog/cart/checkout/fulfillment/order 等。

回答：

> 双方使用什么共同的 Commerce 语义？

UCP 2026-04-08 支持 `a2a` service transport；A2A transport 的 endpoint 指向 Agent Card URL。

## 3.3 Kiwi Negotiation

负责：

```text
Inquiry
RFQ
Offer
CounterOffer
ConditionalOffer
Clarification
Withdraw
Decline
AcceptedNonbindingAgreement
```

这是 **九类核心 Negotiation Objects**。

回答：

> 成交之前，两个经济主体具体怎么谈？

## 3.4 AP2 / Checkout / Payment

不进入 Kiwi A2A v1.0 Core。

```text
AcceptedNonbindingAgreement
        ↓
Transaction Handoff
        ↓
v1.1+
```

---

# 4. 总体设计原则

## 4.1 Protocol-first

```text
Buyer Agent
     ↕
Direct A2A
     ↕
Merchant Agent
```

标准兼容双方不得被强制要求经过 Kiwi Cloud。

## 4.2 Optional Infrastructure

Kiwi MAY 提供：

```text
Directory
Relay
Hosted Merchant
Trust Registry
Observability
Enterprise Policy Service
```

但这些不能成为协议的强制中心。

## 4.3 LLM 负责理解，Protocol 负责事实

自然语言负责交互；结构化 payload 负责商业事实。

LLM 输出 MUST 先成为候选，不能直接成为网络副作用。

## 4.4 Private Intent 与 Public Commitment 分离

默认 Private：

```text
Buyer max budget
Buyer urgency
Merchant cost
Merchant floor price
Internal strategy
Principal Memory
Personal details
```

只有经过 DisclosurePolicy、HardPolicy 和 Approval 明确允许的最小字段才可以对外披露。

## 4.5 Remote Content Is Untrusted

所有 Remote Message、Artifact、Agent Card 扩展内容、UCP vendor metadata 和人类可读文本均 MUST 被视为 untrusted input。

远端内容：

- MUST NOT 直接成为系统指令；
- MUST NOT 自动触发任意本地工具；
- MUST NOT 自动写入 Principal Memory；
- MUST 先经过 schema、身份、策略、披露和权限检查。

## 4.6 Fail Closed

以下任一情况出现，Kiwi MUST NOT 产生新的商业承诺：

```text
unknown protocol/version
schema invalid
identity mismatch
capability mismatch
stale approval
replay conflict
private data risk
remote state uncertainty
condition conflict
```

---

# 5. 总体架构

```text
Principal
   │
   ▼
Operator / UI
   │
   ▼
Principal Control Plane
   │
   ├── HardPolicy
   ├── SessionStrategy
   ├── TurnInstruction
   ├── NetworkDisclosurePolicy
   └── Approval
   │
   ▼
AgentKernel
   │
   ├── Memory / Vault
   ├── Task Scheduler
   ├── ReasoningBackend
   │      ├── Embedded Pi
   │      ├── OpenClaw ACP-Runtime
   │      └── Hermes ACP-Runtime
   │
   ▼
Negotiation Engine
   │
   ├── Negotiation State
   ├── NegotiationActionCandidate
   ├── Ledger
   ├── UCP Capability
   └── Trust
   │
   ▼
CounterpartyChannel
   │
   ├── A2ADirectChannel
   ├── ShoppingCliHostedChannel
   └── PlatformApiChannel
```

---

# 6. 术语迁移

| 旧概念 | 新概念 | 说明 |
|---|---|---|
| CommerceConnector | CounterpartyChannel | 对方可能是 Agent、Gateway 或平台 |
| CommerceGateway | ShoppingCliHostedChannel | shopping-cli 是一种 Channel |
| DecisionCandidate | deprecated compatibility term | v0.2 历史名称 |
| ActionCandidate | ActionCandidate | 统一上层候选基类 |
| NegotiationCandidate | 禁止使用 | 旧草稿误引入 |
| Negotiation action | NegotiationActionCandidate | ActionCandidate 子类型 |
| Marketplace Conversation | Hosted Marketplace State | hosted 路径继续存在 |
| ACP | 禁止裸用 | 写 ACP-Runtime 或 ACP-Commerce |
| private policy | HardPolicy / Strategy | 继续沿用已有结构 |
| 新增 | NetworkDisclosurePolicy | 网络披露控制 |
| 旧 PDF 基线 | Markdown canonical source | PDF 仅导出 |

---

# 7. Candidate 模型

## 7.1 ActionCandidate

表示：

> Agent 建议执行、但尚未真正执行的外部有副作用动作。

## 7.2 NegotiationActionCandidate

```text
NegotiationActionCandidate extends ActionCandidate
```

至少绑定：

```text
candidate_id
negotiation_id
action
payload
candidate_digest
expected_remote_revision
policy_version
counterparty_identity
public_message
reason_codes
risk
```

## 7.3 DecisionCandidate

仅作为 v0.2 compatibility term。

```text
DecisionCandidate
      ↓ adapter
NegotiationActionCandidate
```

新代码不得再创建第三套候选模型。

---

# 8. Kiwi Negotiation 的三个公共标识

## 8.1 Internal Identifier

```text
kiwi.negotiation/1.0
```

仅用于 repo/package/logging/schema family。

## 8.2 A2A Extension URI

统一使用项目维护者实际控制域名 `kiwi.harrylabsj.com`（harrylabsj.com 的子域）：

```text
https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0
```

## 8.3 UCP Vendor Capability

本文全部示例统一为：

```text
com.harrylabsj.kiwi.shopping.negotiation
```

namespace 已替换为实际控制域名对应的 reverse-domain（`kiwi.example` 占位符已移除）。
spec / schema 已在 `https://kiwi.harrylabsj.com` 真实托管（UCP origin 绑定已满足，2026-08-06 上线）。
托管面：公开仓库 `harrylabsj/kiwi-spec`（Cloudflare Pages → `https://kiwi.harrylabsj.com`），
协议正文以 `docs/protocol/kiwi-negotiation-protocol-1.0.md` 为权威源。

UCP capability MUST 遵循：

```text
{reverse-domain}.{service}.{capability}
```

其 `spec` / `schema` origin MUST 满足 UCP namespace authority 绑定要求。

## 8.4 三者关系

```text
internal:
kiwi.negotiation/1.0

      implements

A2A:
https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0

      advertises commerce capability

UCP:
com.harrylabsj.kiwi.shopping.negotiation
```

三者不能互换。

---

# 9. Identifier Model

## 9.1 negotiation_id

- negotiation initiator 生成；
- 标识完整业务谈判；
- 跨重启稳定；
- 一个 negotiation 可映射多个 Message / Task；
- 不得复用于无关谈判。

## 9.2 A2A contextId

Kiwi 持久化：

```text
negotiation_id ↔ remote contextId
```

`contextId` 对 Kiwi 是 opaque。

## 9.3 exchange_id

标识一轮语义交换，例如 RFQ→Offer。

## 9.4 message_id

每个 KNP wire message 唯一。

```text
(sender_identity, message_id)
```

是协议级幂等主键。

## 9.5 taskId

只在 A2A Task 存在时使用；不得替代 negotiation_id。

## 9.6 offer_id

每个 Offer / CounterOffer / ConditionalOffer 拥有自己的 `offer_id`。

## 9.7 Target Reference Model

所有 Withdraw / Decline 等“引用既有商业对象”的动作 MUST 使用稳定可引用的扁平 target 字段，而不是假设每种 payload 自带同名 `id`。

Canonical 方向：

```json
{
  "target_message_id": "msg_...",
  "target_offer_id": "off_..."
}
```

规则：

- `target_message_id` 是通用引用，适用于 RFQ、Inquiry、Clarification 及所有消息对象；
- 对 Offer-like 对象 SHOULD 同时携带 `target_offer_id`，用于商业语义和一致性复核；
- 两者同时存在时 MUST 指向同一 Ledger 对象；接收方发现二者不一致时返回 `state_conflict`；
- negotiation-level Cancel / Decline 使用 envelope 的 `negotiation_id`，不得伪造一个不存在的 object id；
- 精确 wire schema 由 Kiwi Negotiation Protocol 1.0 定义。

这样避免 RFQ 没有 `rfq_id`、CounterOffer 又只引用前序 offer 的悬空问题。

---

# 10. 基础数据类型

## 10.1 Money

协议唯一金钱表示：

```json
{
  "currency": "CNY",
  "amount_minor": 83500
}
```

协议 payload 中不得使用 float 表示货币。

## 10.2 Quantity

```json
{
  "value": 200,
  "unit": "piece"
}
```

## 10.3 TermSet

稳定顶层域：

```text
items
price_terms
fulfillment_terms
service_terms
payment_terms
valid_until
```

`payment_terms` 只表达商业条件，不代表支付授权。

---

# 11. Core Negotiation Objects

KNP/1.0 的九类核心对象：

1. Inquiry
2. RFQ
3. Offer
4. CounterOffer
5. ConditionalOffer
6. Clarification
7. Withdraw
8. Decline
9. AcceptedNonbindingAgreement

此外存在协议动作：

```text
accept_nonbinding
cancel
clarification_response
```

这些动作服务于对象生命周期，不与九类业务对象重复计数。

---

# 12. ConditionalOffer

ConditionalOffer MUST 是确定性可求值的。

禁止：

```text
JavaScript
Python
SQL
eval
arbitrary regex execution
arbitrary JSONPath
network callback
model-selected executable rule
```

## 12.1 Condition Grammar

支持：

```text
all
any
```

比较符：

```text
eq
neq
gt
gte
lt
lte
in
```

field 必须来自治理后的 allowlist。

## 12.2 Merge Semantics

KNP/1.0 的正式 wire 子规范 MUST 使用**完整 `then_terms` 结果**，而不是任意字段 patch。

求值规则：

1. 无 rule 命中 → 使用 `base_terms`；
2. 一个 rule 命中 → 使用该 rule 的完整 `then_terms`；
3. 多个 rule 命中且 canonical `then_terms` 完全一致 → 可视为同一结果；
4. 多个 rule 命中且结果不同 → `condition_conflict`；
5. LLM MUST NOT 自行选择某个冲突结果。

因此 KNP/1.0 不定义“不同 rule 各改一个字段后自动 merge”的隐式语义。

`base_terms` MUST 是有效、可单独评估的 TermSet；空 `base_terms` 只有在 schema 明确允许且业务语义完整时才可接受。

## 12.3 Disclosure Interaction

Condition field 若涉及 Buyer segment、location、organization 或其他 Principal attributes，只有在 `NetworkDisclosurePolicy` 已允许该字段公开时才可用于远端条件求值。

私有 Buyer 属性不得因为 Merchant ConditionalOffer 自动被披露。

---

# 13. Negotiation Envelope

Wire Envelope 使用公共 capability namespace。

```text
capability
protocol_version
negotiation_id
exchange_id
message_id
in_reply_to?
actor
action
created_at
payload
public_message?
digest
```

`actor`：

```text
buyer
merchant
```

structured payload 是协议事实。

`public_message` 只是人类可读表达。

两者冲突时不得由模型静默修复，应返回错误或转人工。

---

# 14. Withdraw / Decline / Cancel

## 14.1 Withdraw

Withdraw 用于撤回**本方创建且仍可撤回**的消息或 offer-like object。

必须通过 `TargetRef` 引用。

撤回 active offer：

```text
OFFER_OPEN → OPEN
```

前提是 negotiation 本身仍允许继续。

若撤回的是发起 negotiation 的唯一 RFQ 且明确表示结束整个 negotiation：

```text
→ WITHDRAWN
```

具体是否结束 MUST 由 `scope` 明确表达，不能通过 target 类型猜测。

## 14.2 Decline

Decline 是商业决定，不是协议错误。

两种 scope：

```text
offer
negotiation
```

`scope=offer`：

```text
关闭目标 offer
negotiation MAY 继续
```

`scope=negotiation`：

```text
→ DECLINED
```

## 14.3 Cancel

Cancel 是 negotiation lifecycle 终止：

```text
→ CANCELLED
```

Cancel 不代表取消已经存在的订单；Kiwi A2A v1.0 不管理订单。

## 14.4 Reopen

`DECLINED / WITHDRAWN / CANCELLED / EXPIRED / AGREEMENT_REACHED` 均为 terminal。

若双方希望重新谈判，MUST 创建新的 `negotiation_id`。

---

# 15. AcceptedNonbindingAgreement

终点对象必须明确：

```text
binding_effect = nonbinding
creates_order = false
reserves_inventory = false
authorizes_payment = false
```

任何将上述副作用标记为 `true` 的 KNP/1.0 Agreement 都是非法。

---

# 16. selected_nonbinding

`selected_nonbinding` 是 Buyer 本地 Task State，不是 A2A 协议状态。

Buyer 可以同时持有多个不同 Merchant 的 Agreement，再在本地选择其中一个。

Merchant 无需知道 Buyer 是否选择了其他 Merchant。

---

# 17. Digest 与幂等

使用：

```text
RFC 8785 JCS
+
SHA-256
```

主键：

```text
(sender_identity, message_id)
```

same id + same digest：

```text
不得重复执行
返回原结果或等价 acknowledgment
```

same id + different digest：

```text
idempotency_conflict
fail closed
```

Idempotency retention 至少覆盖：

```text
max(
  offer validity,
  task lifetime,
  24 hours
)
```

完整测试向量由 KNP/1.0 子规范维护。

---

# 18. 三个正交状态模型

**本修订基线**将状态拆成三个正交维度，而不是把它们混在一张状态机里。

## 18.1 Negotiation Phase

```text
OPEN
AWAITING_CLARIFICATION
OFFER_OPEN
AGREEMENT_REACHED
DECLINED
WITHDRAWN
CANCELLED
EXPIRED
```

## 18.2 Approval State

```text
NOT_REQUIRED
PENDING
APPROVED
REJECTED
STALE
```

## 18.3 A2A Task State

完全使用 A2A Task lifecycle。

Kiwi 不再发明另一套 Task 状态。

---

# 19. Approval Pipeline

```text
ReasoningBackend
      ↓
NegotiationActionCandidate
      ↓
bind current local + remote context
      ↓
schema validation
      ↓
HardPolicy
      ↓
NetworkDisclosurePolicy
      ↓
capability check
      ↓
risk assessment
      ↓
Approval Gate
      ↓
approved
      ↓
RE-READ REMOTE STATE
      ↓
RE-VALIDATE PRECONDITIONS
      ↓
send
```

Approval 必须绑定：

```text
candidate_id
candidate_digest
remote_revision
policy_version
counterparty_identity
```

任何绑定字段变化：

```text
→ STALE
```

---

# 20. Eight State Domains

1. User Chat Session
2. Principal Memory
3. Private Vault
4. Task State
5. Operator Control State
6. Reasoning Session
7. Negotiation Ledger / Direct Remote Context
8. Hosted Marketplace Conversation

Hosted Marketplace Conversation 只存在于 `ShoppingCliHostedChannel`。

Remote Message MUST NOT 直接进入 Principal Memory。

Remote 内容只有经过：

```text
classification
evidence governance
sensitivity classification
user confirmation when required
```

之后才可以成为 memory candidate。

---

# 21. Authority Model

Hosted：

```text
shopping-cli authoritative snapshot
>
local cache
>
reasoning state
```

Direct A2A：

```text
remote protocol result
+
confirmed local Ledger record
```

模型 transcript 永远不是 authoritative business state。

---

# 22. Negotiation Ledger

Ledger：

```text
append-only
content-addressed
auditable
hash-linked
```

每条记录 SHOULD 包括：

```text
event_digest
previous_event_digest
message/exchange refs
remote contextId/taskId
identity snapshot
capability snapshot
wire digest
state transition
result/error
timestamp
```

不保存 raw chain-of-thought 和 Vault plaintext。

公开 transcript 的 retention MUST 服从 Principal / enterprise retention policy；删除策略必须与 Ledger 审计要求分层设计，不能因为删除聊天 UI transcript 就破坏仍在 retention window 内的协议幂等证据。

---

# 23. Recovery and Reconciliation

恢复流程：

```text
1. Load local negotiation
2. Load Ledger high-water mark
3. Resolve counterparty/channel
4. Re-fetch remote context/task state
5. Compare acknowledged messages
6. Reconcile remote state × Ledger
7. Expire stale candidates/approvals
8. Resume scheduler/subscription
```

Remote ahead：

```text
fetch → validate → append Ledger
```

Local pending / remote unknown：

```text
same message_id + same digest
→ safe idempotent retry
```

不可调和：

```text
→ reconciliation_required
→ human review
```

---

# 24. Hosted 与 Direct Reliability

Hosted：

```text
claim
heartbeat
complete
fail
abandon
stale recovery
```

这些仅属于 `ShoppingCliHostedChannel`。

Direct A2A：

```text
A2A Message
A2A Task
Subscribe / Poll
message idempotency
Ledger
reconciliation
```

Direct A2A 不伪造 claim/heartbeat。

---

# 25. UCP Integration

Merchant 通过：

```text
/.well-known/ucp
```

发布 UCP Profile。

支持 A2A：

```json
{
  "transport": "a2a",
  "endpoint": "https://merchant.example/.well-known/agent-card.json"
}
```

endpoint 指向 Agent Card。

## 25.1 Platform Profile Advertisement

HTTP-based A2A bindings可使用 UCP 规范要求的 `UCP-Agent` 等 service parameters 来声明 platform profile。

对于非 HTTP binding（例如 GRPC），Kiwi MUST 遵守该 binding 对 A2A service parameters 的正式映射，而不是假设存在 HTTP header。

具体 wire mapping 由 A2A/UCP integration 子规范钉死。

## 25.2 Negotiation Capability

Kiwi Negotiation 默认是：

```text
Vendor Root Capability
```

不带 `extends`，除非未来版本明确扩展标准 UCP parent capability。

---

# 26. Agent Card

Agent Card 应至少覆盖 Kiwi 实际依赖的：

```text
name
description
provider
version
supportedInterfaces
securitySchemes
security
capabilities
skills
extensions
```

完整示例：

```json
{
  "name": "Example Merchant Agent",
  "description": "Merchant commerce negotiation agent",
  "provider": {
    "organization": "Example Merchant"
  },
  "version": "1.0.0",
  "supportedInterfaces": [
    {
      "url": "https://merchant.example/a2a",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ],
  "securitySchemes": {},
  "security": [],
  "capabilities": {
    "extendedAgentCard": true,
    "extensions": [
      {
        "uri": "https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0",
        "required": false
      }
    ]
  },
  "skills": [
    {
      "id": "commerce-negotiation",
      "name": "Commerce Negotiation",
      "description": "Pre-transaction inquiry, RFQ, offer and negotiation"
    }
  ]
}
```

A2A 1.0 core bindings 当前包括：

```text
JSONRPC
GRPC
HTTP+JSON
```

Custom binding 使用正式 URI namespace。

Agent Card MUST NOT contain static secrets, bearer tokens, API keys, passwords, private signing keys, Merchant cost/floor data, or Principal private state.

---

# 27. Trust Model

拆成：

```text
Identity Trust
Protocol Trust
Commercial Reputation
```

不得合并成单一“可信度”。

## Identity Trust

来源 MAY 包括：

```text
HTTPS domain
OAuth/OIDC
mTLS
HTTP Message Signatures
UCP signing keys
Agent Card JWS
```

## Protocol Trust

例如：

```text
schema validity
replay behavior
capability accuracy
timeout behavior
signature validity
```

## Commercial Reputation

来源：

```text
local Ledger experience
external reputation provider
platform reputation
user feedback
```

没有 reputation 就是：

```text
unknown
```

不能自动当成 neutral 0.5。

Dispute 事件如果未来进入 reputation，必须区分：

```text
local_asserted_dispute
mutually_acknowledged_dispute
third_party_adjudicated_dispute
```

不得把本地单方标记伪装成全球事实。

---

# 28. Trust Levels

```text
T0 UNKNOWN
T1 DISCOVERED
T2 AUTHENTICATED
T3 VERIFIED_RELATIONSHIP
```

Trust level 只控制协议/自动化风险，不等于产品或 Merchant 推荐等级。

---

# 29. NetworkDisclosurePolicy

控制：

```text
location precision
organization identity
buyer urgency
contact information
purchase quantity
budget hints
customer segment
historical preferences
```

任何 Condition 或 RFQ 想使用上述属性，都必须先通过 DisclosurePolicy。

---

# 30. RFQ Fan-out Privacy

Fan-out 受：

```text
max_recipients
minimum_trust
disclosure_profile
anonymous_first_round
category_sensitivity
```

控制。

推荐 progressive disclosure，而不是默认向所有 Merchant 广播完整需求。

---

# 31. Abuse Mitigation

Public Merchant endpoint 必须考虑：

```text
RFQ spam
price scraping
resource exhaustion
identity cycling
malformed schema floods
replay floods
capability probing
```

至少 SHOULD 支持：

```text
per-identity rate limit
per-domain rate limit
backoff
payload-size limit
task concurrency limit
malformed-request budget
replay protection
trust-based throttling
```

---

# 32. Error Model

协议错误与商业 Decline 必须分开。

至少：

```text
protocol_version_unsupported
capability_incompatible
schema_invalid
field_unsupported
structured_text_conflict
identity_rejected
authentication_required
authorization_failed
offer_unknown
offer_expired
offer_withdrawn
terms_digest_mismatch
condition_conflict
state_conflict
approval_required
idempotency_conflict
replay_detected
rate_limited
temporarily_unavailable
reconciliation_required
```

---

# 33. Discovery / Channel 职责

## AgentDiscovery

负责：

```text
domain → UCP Profile
profile → Agent Card
capability intersection
identity bootstrap
channel candidates
```

## CounterpartyChannel

负责：

```text
open
send
getState
subscribe
close
```

`subscribe` 是异步推送/stream 订阅能力；没有 `subscribe` 的 channel 可通过 `getState` 轮询。

接口使用的 `DiscoveryInput`、`CounterpartyProfile`、`ChannelOpenInput`、`RemoteContext`、`RemoteRef`、`RemoteState`、`RemoteEvent`、`ChannelResult`、`NegotiationEnvelope` 等类型属于子规范/实现接口定义，不在本文内冻结字段。

---

# 34. shopping-cli 定位

从：

```text
唯一 Commerce Gateway
```

变为：

```text
Hosted / Legacy Commerce Infrastructure
```

架构：

```text
                      ┌─ Direct A2A Merchant
                      │
Kiwi Negotiation ─────┼─ shopping-cli Hosted Merchant
                      │
                      └─ Platform API Merchant
```

---

# 35. Legacy Migration

```text
shopping.negotiation/0.1
= frozen legacy wire contract

Kiwi Negotiation Protocol 1.0
= canonical new negotiation domain
```

Adapter：

```text
lossless → translate
lossy → fail closed
unsupported → human/fallback
```

不得静默丢弃：

```text
conditions
expiry
identity
agreement semantics
```

---

# 36. Security Invariants

标记：

```text
[E] existing enforcement
[N] new A2A invariant
```

1. `[E]` 一个 Kiwi 实例只代表一个 Principal Role。
2. `[E]` Buyer 与 Merchant Memory / Vault / Credentials 隔离。
3. `[E]` ReasoningBackend 不拥有 Commerce 写权限。
4. `[E]` 模型输出不能直接执行外部副作用。
5. `[E]` 不保存 raw chain-of-thought。
6. `[E]` v1.0 不创建订单。
7. `[E]` v1.0 不执行支付。
8. `[E]` v1.0 不执行退款。
9. `[E]` v1.0 不锁库存。
10. `[N]` Remote Agent 不获得 Principal Memory。
11. `[N]` Remote Agent 不得通过协议内容获得任意本地工具执行权。
12. `[N]` 所有 Remote Content 必须视为 untrusted input。
13. `[N]` Remote Message 不得直接写入 Principal Memory。
14. `[N]` `public_message` 不得覆盖 structured payload。
15. `[N]` Direct A2A 写入必须有幂等语义。
16. `[N]` approval 必须绑定 remote revision / candidate digest / policy version。
17. `[N]` remote state 变化使 approval stale。
18. `[N]` unknown protocol/version fail closed。
19. `[N]` identity mismatch fail closed。
20. `[N]` duplicate message ID + different digest fail closed。
21. `[N]` Direct Channel 失败不得自动降级到权限更宽的 Channel。
22. `[N]` Legacy Adapter 不得扩大权限。
23. `[N]` Condition evaluation 不允许 executable expressions。
24. `[N]` Agent Card / UCP Profile / public metadata 不得包含静态 secret。

任何未来修订删除安全不变量时，必须在 changelog 中显式记录理由。

---

# 37. Reliability 前置整改

在 Direct A2A 开发前先完成现有 Hosted Runtime 问题：

P0：

```text
claim escape recovery
fake claim semantics
```

P1：

```text
--once signal cleanup
log redaction
filesystem permissions
```

---

# 38. 推荐代码结构

```text
src/
├── agent/
├── operator/
├── reasoning/
│   ├── embedded-pi/
│   ├── openclaw-acp-runtime/
│   └── hermes-acp-runtime/
├── discovery/
│   ├── ucp/
│   ├── agent-card/
│   └── capability/
├── a2a/
│   ├── client/
│   ├── server/
│   ├── auth/
│   └── extensions/
├── negotiation/
│   ├── domain/
│   ├── schema/
│   ├── candidate/
│   ├── engine/
│   ├── condition/
│   ├── state/
│   ├── ledger/
│   ├── idempotency/
│   ├── recovery/
│   └── errors/
├── counterparty/
│   ├── channel.ts
│   ├── a2a-direct/
│   ├── shopping-cli-hosted/
│   └── platform-api/
├── trust/
│   ├── identity/
│   ├── protocol/
│   └── reputation/
└── protocol/
    ├── kiwi-negotiation/
    └── legacy-shopping-negotiation/
```

---

# 39. Roadmap

## v0.3

现有 Agent-first Runtime。

## v0.4 — Protocol Foundation

```text
reliability fixes
canonical markdown baseline
terminology migration
ActionCandidate unification
Negotiation domain objects
Identifier / TargetRef model
Condition evaluator
Ledger
Idempotency
Legacy Adapter
```

## v0.5 — Native A2A

```text
A2A Client
A2A Server
Agent Card
Direct Channel
Message
Task
context recovery
authentication
```

## v0.6 — UCP Interop

```text
/.well-known/ucp
UCP profile
A2A service binding
profile advertisement
capability intersection
Kiwi vendor capability
spec/schema hosting
```

## v0.7 — Open Network

```text
multi-merchant RFQ
Trust
fan-out policy
rate limiting
abuse mitigation
interop tests
optional directory
```

## Kiwi A2A v1.0

完整：

```text
Need
→ Discovery
→ Inquiry / RFQ
→ Offer
→ CounterOffer
→ ConditionalOffer
→ Clarification
→ AcceptedNonbindingAgreement
```

---

# 40. Testing Ownership

测试分为两层。

## 40.1 Architecture / Runtime Test Plan

由独立测试计划维护：

```text
docs/testing/kiwi-a2a-v1-test-plan.md
```

至少覆盖：

```text
runtime unit tests
A2A interoperability
UCP profile/capability
legacy compatibility
security
reliability/recovery
abuse/fan-out
```

## 40.2 Protocol Conformance Vectors

由：

```text
Kiwi Negotiation Protocol 1.0
```

维护：

```text
JSON Schema vectors
digest vectors
idempotency vectors
condition vectors
state-transition vectors
agreement invariants
```

---

# 41. v1.0 Completion Definition

Kiwi 只有同时满足以下条件才宣布 A2A v1.0：

1. Buyer 与 Merchant 都能作为独立 A2A Agent。
2. 不依赖共同 Kiwi Gateway 即可完成谈判。
3. 能发现 UCP Profile。
4. 能发现并验证 Agent Card。
5. 能协商双方 capability intersection。
6. Kiwi Negotiation 有公开稳定 namespace。
7. 九类核心 Negotiation Objects 有冻结 schema。
8. ConditionalOffer 可确定性求值。
9. ID / TargetRef 模型有明确生命周期。
10. Message replay 具备幂等。
11. duplicate ID / different digest 可检测。
12. 多轮谈判可跨进程恢复。
13. A2A Task 可跨进程恢复。
14. remote/local divergence 可 reconciliation。
15. approval stale 可检测。
16. Principal Memory 不进入 remote context。
17. Remote Content 不能直接成为 Principal Memory。
18. Remote Agent 不能获得任意本地工具能力。
19. Hosted 与 Direct 共用同一 Negotiation domain semantics。
20. Legacy Adapter 保持 shopping-cli 兼容且不扩大权限。
21. reasoning backend 不改变 wire semantics。
22. 安全测试全部通过。
23. RFQ abuse / fan-out privacy tests 全部通过。
24. network partition / replay / restart tests 全部通过。
25. 没有订单副作用。
26. 没有支付副作用。
27. 没有库存预留副作用。

**A2A v1.0 已宣布（2026-08-07）**：上述 27 条完成定义经就绪度审计（
`docs/kiwi-a2a-v1.0-readiness-audit-2026-08-06.md`）逐条实证满足（27/27）。
namespace 与 schema 托管于 `https://kiwi.harrylabsj.com`（公开仓库 `harrylabsj/kiwi-spec`）。

---

# 42. Canonical Child Specifications

本文基线化后，规范树如下：

```text
docs/
  kiwi-a2a-architecture-baseline.md          # canonical architecture source

docs/protocol/
  kiwi-negotiation-protocol-1.0.md          # normative negotiation wire spec

schemas/
  ...

test-vectors/
  ...

docs/testing/
  kiwi-a2a-v1-test-plan.md                   # runtime / interop / security plan
```

PDF、网页和其他格式均由 canonical Markdown 生成。

---

# 43. External Standards Baseline

本架构 pin 以下外部依赖：

- Agent2Agent Protocol (A2A) v1.0.x
  - Agent Card well-known discovery
  - `supportedInterfaces`
  - core bindings: `JSONRPC`, `GRPC`, `HTTP+JSON`
  - A2A Message / Task / Artifact / contextId
  - RFC 8785 Agent Card canonicalization/signature behavior
- Universal Commerce Protocol (UCP), 2026-04-08 specification family
  - `/.well-known/ucp`
  - `a2a` service transport
  - A2A endpoint → Agent Card
  - vendor capability namespace authority rules
- RFC 8785 JSON Canonicalization Scheme
- SHA-256
- HTTP Message Signatures where selected by TrustPolicy
- OAuth 2 / OIDC / mTLS where selected by deployment

AP2 与 ACP-Commerce 属于 v1.1+ Transaction Handoff，不是 Kiwi A2A v1.0 Core。

---

# 44. Final Architectural Position

Kiwi 不应该把壁垒建立在：

```text
某一个大模型
```

也不应只建立在：

```text
中央 Shopping Gateway
```

长期壁垒应是：

```text
Principal Agent Runtime
+
Private Preference Model
+
Negotiation Intelligence
+
Negotiation Protocol
+
Trust / Policy / Approval
+
A2A / UCP Interoperability
```

Kiwi 最终代表的是：

> **一个能够长期代表真实经济主体，在开放 Agent 网络中寻找交易对手、保护私有意图、协商商业条件、形成可验证非绑定共识，并把共识安全交给后续交易系统的经济 Agent。**
