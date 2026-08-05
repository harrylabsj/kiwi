---
title: Kiwi A2A Agent Commerce Network v1.0 文档评审
created: 2026-08-05
type: research-note
topic: kiwi_a2a_v1.md 架构文档评审
status: review
tags: [doc-review, kiwi, a2a, negotiation, architecture]
---

# Kiwi A2A v1.0 文档评审

**评审对象**：`<WORKSPACE>/kiwi/docs/kiwi_a2a_v1.md`（v1.0-draft，2026-08-05，34 章 + 2 附录，约 33KB）

**评审方法**：对照项目现状（`src/` 结构与 README）以及文档继承的四份既有文档——`agent-runtime-v0.3.md`、`operator-tui-v0.2.md`、`external-agent-adapters-v0.2.md`、`code-review-2026-08-04.md`——并核实两条外部规范事实（A2A Agent Card、UCP Profile）。文中行号引用基于 2026-08-05 评审版本，修订后可能漂移，以章节号为准。

**评审范围**：只读，未修改任何文件。

---

## 1. 总体判断

作为"母文档"，底子是好的：`Protocol-first`、`Open Network, Optional Infrastructure`、`Fail Closed`、`Private Intent / Public Commitment 分离`这些定位都站得住；§3.5 的 ACP 消歧、§12 的 Ledger 去中心化思路、§26 的 20 条不变量是真正用心的部分。

**但作为协议文档，它目前最缺的是"把承诺变成可验证结构"**：

- 核心创新对象（ConditionalOffer 等）没有 schema，验收无法落地；
- 两个关键机制（条件报价、协商恢复）悬空；
- 术语在文档自身内部已经出现矛盾（§16 候选类型），也与继承文档脱节；
- 一处对 UCP 规范的事实性错误（transport = a2a）。

这些不修，落地时必然各写各的。按严重度分为 P0（必须修/必须决策）、P1（一致性与缺口）、P2（细节与小问题）。

---

## 2. P0 — 必须修 / 必须决策

### 2.1 `ConditionalOffer` 的条件结构完全未定义

- 位置：§8.2（L666-674）
- 问题：条件报价是全文最核心的创新对象，却只有散文描述（"如果数量 ≥ 500 则单价 = X / 如果分两批交付则第二批交期 = Y"）。条件怎么表达、怎么求值、`then` 里是否可嵌套、多个条件之间是与还是或——全部悬空。
- 矛盾点：§32 完成定义 #5 要求 v1.0 必须"能表达 ConditionalOffer"，但 §8.2 没有给出可验证的表示。这是自相矛盾的最高优先级缺口。
- 处置：要么本轮给出条件 schema（如 `conditions: [{when: {quantity_min: 500}, then: {...}}]` + 求值语义），要么明确把 ConditionalOffer 降级为 v1.0 范围外。

### 2.2 `CounterOffer / Clarification / AcceptedNonbindingAgreement` 只有散文，没有 JSON

- 位置：§8.2（L660-692）
- 问题：Inquiry 有散文、RFQ/Offer 有 JSON，但 CounterOffer、Clarification、AcceptedNonbindingAgreement 三个对象既无 schema 也无示例。尤其 `AcceptedNonbindingAgreement` 是 v1.0 的终点产物（§32 的验收对象），它长什么样没有定义。
- 影响：协议文档里"终点对象无 schema"，等于完成定义无法验证。

### 2.3 候选类型在 §16 内部自相矛盾，且与继承文档脱节

- 位置：§16（L1026-1061）
- 问题：
  1. L1031 说"所有外部商业 Action 仍必须形成 **ActionCandidate**"，同一节的流程图（L1044-1046）却用 **NegotiationCandidate**——同节内两个名称。
  2. 继承来的候选类型已经有**两个**：`DecisionCandidate`（operator-tui-v0.2 §4）和 `ActionCandidate`（agent-runtime-v0.3 §16），本文件又引入第三个 `NegotiationCandidate`，全程没有说明三者关系（改名？子类型？新东西？）。
- 影响：直接导致实现分叉。必须定义 `NegotiationCandidate` 与 `DecisionCandidate` / `ActionCandidate` 的映射。

### 2.4 §16 审批流程顺序与 v0.2 相反，且丢了"发送前重验前置状态"

- 位置：§16（L1040-1060）对比 operator-tui-v0.2.md §4
- 问题 1（顺序相反）：
  - v1.0 流程：`Schema → HardPolicy → Disclosure → Capability → Approval Gate → send()`，即**先校验后审批**；
  - v0.2 流程：`DecisionCandidate → Approval Gate → bind+schema+policy → CommerceClient`，即**先审批后校验**。
  - 先校验后审批在逻辑上更合理，但文档没标注这是对 v0.2 的有意变更，实现者会无所适从。
- 问题 2（缺重验）：v0.3 §16 明确要求"执行前重新读取前置状态、参数或前置状态变化后旧批准失效"。v1.0 流程 `Approval → send()` 之间没有这一步——异步长协商里，审批与发送之间状态可能已变化。

### 2.5 "UCP transport = a2a" 与 UCP 2026-04-08 实际规范不符

- 位置：§7.2（L556-563）
- 问题：文档声称 A2A 模式下 UCP Profile 的 `transport = a2a`。但文档自己在 Appendix B 引用的 UCP 2026-04-08 规范族里，`ucp.services` 的 transport 枚举是 **`rest` / `mcp` / `embedded`**，没有 `a2a`。且 UCP 标准 capabilities 集（checkout / fulfillment / discount / order / catalog.search / catalog.lookup / cart）里**没有 negotiation 类目**。
- 解读：这反过来印证 §8.1"Kiwi Negotiation 是 vendor capability"的定位是对的，但"UCP-over-A2A binding"整节的成立前提（UCP 允许 a2a transport）目前不成立。
- 处置：给出真实的绑定机制——例如 UCP service 定义里指向 A2A endpoint、或通过 vendor capability 声明——而不是虚构一个 transport 值。

---

## 3. P1 — 一致性与缺口

### 3.1 §13 七个状态域删掉了 `Marketplace Conversation`，与 §12.1 冲突

- 位置：§13（L905-938）对比 §12.1（L883-901）与 agent-runtime-v0.3.md §5
- 问题：v0.3 的五域里有 `Marketplace Conversation`；v1.0 七域里它消失，换成 `Negotiation Ledger / Remote Context`。但 §12.1 明确说 hosted 路径"权威状态仍然优先来自 shopping-cli Gateway snapshot"——即 hosted 路径下 Marketplace Conversation **仍然存在且仍然权威**，只是没被列为一个状态域。
- 处置：要么加回 Marketplace Conversation（共八域），要么显式声明"hosted 路径下 Marketplace Conversation 归入域 7"。

### 3.2 协商恢复语义没有定义

- 位置：§12、§10.2、§32.6/7
- 问题：§32.6 要求"多轮谈判可通过 A2A contextId 恢复"，§32.7 要求"异步任务可通过 A2A Task 恢复"，§12 的 Ledger 也被赋予恢复职责，但全文没有给出**重启后在途协商的恢复流程**：
  - 是 `openContext(remote contextId)` 重新拉远端状态再与本地 Ledger 对账？
  - 还是回放本地 Ledger？
  - 两边冲突时谁赢？
  - 丢失的消息怎么发现（靠 digest 断链？）？
- 备注：`CounterpartyChannel.openContext` 接口存在（L393），但"resume = 对账（远端快照 × 本地 Ledger）"这一步没有写。这是 v1.0 成立与否的关键机制。

### 3.3 Offer 的载体在 Message 和 Task 之间分界不清

- 位置：§10.1（L728-745）对比 §10.3（L767-792）
- 问题：§10.1 说"普通协商优先映射为 A2A Message"（Offer 属于普通协商），§10.3 的示例又把 `RFQ → Task → Offer Artifact` 作为异步产出。同一对象既能走消息又能走 Task artifact，但没有**决策规则**（何时走 Task？按时长？按是否人工介入？）。§19"异步收 Offer"到底是 push 消息、streaming 还是 Task poll，必须定一个。

### 3.4 价格表示不一致

- 位置：§3.3（L211-221）对比 §8.2（L650-653）
- 问题：§3.3 的 counter_offer 例子里 `requested_unit_price: 83500`（裸整数），§8.2 的 Offer 例子里是 `unit_price: {currency, amount_minor}`（结构化对象）。协议文档里金钱的规范表示必须是唯一的，否则校验器会分叉。
- 处置：统一为 `{currency, amount_minor}`，§3.3 的例子也用它。

### 3.5 接口类型大量"已使用未定义"

- 位置：§5.1（L388-399）、§25（L1494-1531）
- 未定义但已出现在签名里的类型：`CounterpartyProfile`、`RemoteContext`、`RemoteState`、`RemoteEvent`、`ChannelResult`、`DiscoveryInput`、`NegotiationIntent`、`NegotiationSession`、`NegotiationEvent`、`NegotiationSnapshot`、`VerificationResult`、`CounterpartyEvent`、`NegotiationDecision`、`TrustAssessment`。
- 处置：作为母文档可以留占位，但应像 L509-510 对待 `kiwi-domain` 那样明确标注"这些是接口占位，由对应子文档定义"，否则会被当成已定稿。

### 3.6 "OpenClaw / Hermes 作为外部 reasoning backend"被列为"继承能力"，但实际未实现

- 位置：§0.1（L42）
- 问题：external-agent-adapters-v0.2.md 状态明确是"未实现"；operator-tui-v0.2 说 "Hermes / OpenClaw ACP Adapter 仍为 v0.2.1 设计、未实现"；代码里只有 Embedded Pi 路径。
- 处置：标注为"已设计、未实现"，避免读者误以为有可用的底座。

### 3.7 Direct A2A 下 claim/heartbeat 模型是否仍适用没有交代

- 位置：§23（L1361-1423）对比 §10.3、§14.3
- 问题：§23 的可靠性整改（claim escape recovery、fake claim semantics 等）全部针对 hosted claim 路径。但直连 A2A 世界没有 shopping-cli，claim / heartbeat / 幂等要么映射到 A2A Task 生命周期（working/completed + poll），要么由 Ledger 承担——文档没有说。§14.3 让 Task Scheduler 负责"A2A Task poll / subscribe"，暗示了映射方向，但没写清楚 claim 语义与 A2A Task 的对应关系。

### 3.8 Merchant reputation 有数据来源缺口

- 位置：§19（L1217-1223）、§17.1（L1100-1124）
- 问题：Ranker 比较 `reputation`，§17.1 把 `Merchant Reputation` 列为独立维度，但全文没定义**信誉数据从哪来**（自己 Ledger 的历史？外部来源？用户举报？）。对从未交易过的 Merchant，"reputation"是空的，但排名契约里它是个加权维度。
- 处置：至少定义"信誉缺失时的默认值/权重行为"。

### 3.9 `selected_nonbinding` 与 `AcceptedNonbindingAgreement` 的关系未定义

- 位置：§19（L1247）对比 §28（L1600-1613）
- 问题：§19 结束于 `selected_nonbinding → v1.1 Checkout Handoff`，§28 又说 v1.1 从 `AcceptedNonbindingAgreement → UCP Cart/Checkout` 进入。一个是 Buyer Task 状态（v0.3 概念），一个是 A2A 协商状态（v1.0 概念），两个"handoff 输入"谁是谁的包装没有说明。另外 `selected_nonbinding` 是 Buyer 与 Principal 之间的事（不经过 Merchant），不在 §11 的 A2A 状态机里——文档没澄清"选定"是本地任务概念而非协议概念。

---

## 4. P2 — 细节与小问题

### 4.1 状态机缺口（§11, L794-845）

- `Offered → Clarifying` 不存在（收到报价后想澄清只能先 counter 再 clarify，绕路）。
- `Declined` / `Expired` 是终态不可复活（卖方想重新报价无入口）。若是有意为之应注明。

### 4.2 state/object 混用

`RFQ`、`Inquiry` 既是 §8.2 的消息对象又是 §11 的状态；`AcceptedNonbindingAgreement` 对象 ↔ `AcceptedNonbinding` 状态。若"状态 = 等待该对象"是有意建模，应一句话写明，否则歧义。

### 4.3 Agent Card 示例与规范不一致（§6.2, L475-505）

- `protocolBinding: "JSONRPC"` 不是 A2A 1.0 的标准值，规范用 `HTTP+JSON`（流式变体 `HTTP+SSE`）。
- JSON 缺 `provider`、`securitySchemes` / `security`、`pushNotifications`——文字清单（L461-471）列了 authentication/security schemes 和 push notification，JSON 一个都没演示。
- §17 要求"Agent Card signature verification"：A2A 1.0 支持可选的 `signatures`（JWS）字段，文档应明确 Kiwi 将**强制要求**该字段，并定义签名密钥管理（可对标 UCP profile 的 `signing_keys` JWK / ECDSA P-256）。

### 4.4 v1.0 双关

frontmatter `version: v1.0-draft` 与产品目标版本 v1.0（§30 roadmap）撞号。产品才到 0.3.0，文档号定为 v1.0 会让 0.4 / 0.5 阶段难以引用。建议文档用独立版本号或 `v0.4+ target`。

### 4.5 术语无迁移表

本文件改名/新造了不少词：`ACP → ACP-Runtime`、`CommerceConnector → CounterpartyChannel`、`Marketplace Conversation → Negotiation Ledger / Remote Context`、新增 `NetworkDisclosurePolicy`；既有文档仍用旧词。建议加一张 **旧术语 → 新术语 → 位置** 的表，一行一术语，落地时全仓库检索才不遗漏。

### 4.6 §26 不变量未区分"已强制"与"v1.0 新增"

如 #1"一个 Kiwi 实例只代表一个 Principal Role"已成立，而 #10"public_message 不能绕过结构化 payload"是全新要求。20 条混排，评审/验收时无法逐条判定。建议加列"现状已强制 / v1.0 新增"。

### 4.7 §8.1 两套 namespace 没说清

UCP vendor capability 用 reverse-DNS（`com.<kiwi-domain>.negotiation`，与 UCP capability 命名风格一致，方向对），A2A extension 用 HTTPS URI（`https://<kiwi-domain>/extensions/negotiation/1.0`）。两套标识各管一层，文档应显式说明二者并存且不能互相替代。

### 4.8 `verifyChain` 语义（§25, L1521）

内容是"content-addressed"还是"哈希链"（每条 digest 包含前一条 digest）？`verifyChain` 暗示后者，但 §12 只写了 content-addressed。一句话定死即可。

### 4.9 roadmap 从 v0.3 起跳（§30, L1655-1746）

§0.1 继承清单里混着大量 v0.2 能力，v0.2 没有版本入口。非错误，但 reader 会困惑"v0.2 哪去了"。

### 4.10 §26 #12-15 与 §27 重复

no-order / no-payment / no-refund / no-reservation 在 §27"不支持"里已列，§26 再列一遍。可以，但建议 §26 直接引用 §27，避免两处漂移。

---

## 5. 外部规范核对结果

评审期间实际核实的外部规范事实：

| 文档声称 | 实际规范 | 结论 |
| --- | --- | --- |
| `/.well-known/ucp`（§7.2） | UCP Profile 确在 `/.well-known/ucp`，公开、免认证、可缓存 | ✅ 正确 |
| `/.well-known/agent-card.json`（§6.1） | A2A 确用该 well-known 路径 | ✅ 正确 |
| UCP `transport = a2a`（§7.2） | UCP 2026-04-08 transport 枚举为 `rest` / `mcp` / `embedded` | ❌ 需改（见 §2.5） |
| Agent Card `protocolBinding: "JSONRPC"`（§6.2） | A2A 1.0 为 `HTTP+JSON` / `HTTP+SSE` | ❌ 需改（见 §4.3） |
| Agent Card `capabilities.extensions: [{uri, required}]`（§6.2） | 与 A2A 一致 | ✅ 正确 |
| UCP capabilities 集含 negotiation | UCP 标准 capabilities 为 checkout / fulfillment / discount / order / catalog / cart，**不含** negotiation | 印证 §8.1 vendor capability 定位，但绑定机制需另定（见 §2.5） |

参考：

- [Google Universal Commerce Protocol (UCP) Guide — UCP profile](https://developers.google.com/merchant/ucp/guides/ucp-profile)
- [Google Universal Commerce Protocol (UCP) Guide — Embedded checkout](https://developers.google.com/merchant/ucp/guides/checkout/embedded)
- [A2A 协议 Agent Card](https://github.com/agentpatterns-ai/website/blob/main/standards/agent-cards.md)
- [A2A — Agent Discovery](https://github.com/a2aproject/A2A/blob/7b900e77/docs/topics/agent-discovery.md)
- [A2A Tutorial — Agent Skills & Agent Card](https://a2a-protocol.org/v1.0.0/tutorials/python/3-agent-skills-and-card/)

---

## 6. 做得好的（建议保留的形态）

- **§3.5 ACP 消歧**是全文最被低估的一笔——两个 ACP 在现实里真的会被搞混，"禁止写裸 ACP"是可执行的纪律。
- **§3.4 的 Private/Public 分离清单 + §26 的"不变量禁止被任何新协议破坏"**，把安全边界写成了不可谈判条款，与 README 的 fail-closed 气质一致。
- **§12.1 的双路径权威规则**（hosted → shopping-cli 快照；direct → 远端 response + 本地 exchange record）处理得干净。
- **占位符自曝**（L509-510 的 `kiwi-domain` 占位标注）是好习惯——问题只是占位符不止 `kiwi-domain` 一处（见 §3.5）。
- 引用外部规范时"标准解决的事情不重复发明"（Appendix B）是正确的战略姿态。

---

## 7. 建议的下一步

按收益排序：

1. **先补 §2.1 + §2.2**（ConditionalOffer 条件 schema + CounterOffer / Clarification / AcceptedNonbindingAgreement 的 JSON 示例）——这是"协议资产"的全部含金量所在，也是 §32 验收能否成立的前提。
2. **修 §2.3 / §2.4 / §2.5** 三处自相矛盾，它们会直接造成实现分叉。
3. **补 §3.2（恢复语义）**：一条"重启后 resume = 对账（远端 contextId 快照 × 本地 Ledger）"的段落，以及"丢失消息检测靠 digest 断链"的一句话。
4. 在完成 §2-§3 的决策后，用 §4.5 的术语迁移表扫一遍全仓库旧术语，再进入 v0.4 编码。
