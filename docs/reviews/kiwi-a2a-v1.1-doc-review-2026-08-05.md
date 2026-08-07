---
title: Kiwi A2A Agent Commerce Network 基线 v1.1 文档评审
doc_revision: "1.1"
reviewed: 2026-08-05
type: research-note
topic: Kiwi-A2A-Agent-Commerce-Network.pdf（doc_revision 1.1）文档评审
status: review
tags: [doc-review, kiwi, a2a, negotiation, architecture]
---

# Kiwi A2A Agent Commerce Network 基线 v1.1 文档评审

**评审对象**：`docs/Kiwi-A2A-Agent-Commerce-Network.pdf`（`doc_revision: "1.1"`，`target_product: Kiwi A2A v1.0`，2026-08-05，48 页 / 45 章）。同文件亦存在于 `~/Downloads/Kiwi A2A Agent Commerce Network 总体架构基线.pdf`（字节级一致）。

**评审方法**：PDF 全文文本提取通读 + 与两份既有 review 对照：
- 本文件评审基线为 v1.0-draft 的 `kiwi-a2a-v1-doc-review-2026-08-05.md`；
- 另见 `kiwi_a2a_v1-review-2026-08-05.md`（对 v1.0-draft md 的另一份独立评审）。

并复核外部规范事实（UCP A2A transport 绑定、A2A 1.0 Agent Card 的 `protocolBinding` 枚举）。文中行号基于 PDF 文本提取版（`pdftotext`），以章节号为准。

**评审范围**：只读，未修改任何文件。

---

## 1. 重要更正声明

本文件评审过程中**撤回上一轮 review 的一个判断**：

- 上轮 P0-5 声称"UCP `transport = a2a` 与 2026-04-08 规范不符，transport 枚举只有 rest/mcp/embedded"。
- **该判断错误。** 本次核实：UCP 确实定义 A2A transport 绑定（REST / MCP / A2A 三种），且 `/.well-known/ucp` 下 a2a service 的 endpoint 指向 Agent Card URL（`services.dev.ucp.shopping.a2a.endpoint`）。
- 因此 1.1 文档 §27 的 `{"transport": "a2a", "endpoint": "https://merchant.example/.well-known/agent-card.json"}` 是**正确的**。
- 此前生成的 `kiwi-a2a-v1-doc-review-2026-08-05.md` 中 §2.5 与外部规范核对表携带同一错误结论，**待订正**。另一份 `kiwi_a2a_v1-review-2026-08-05.md` 在该点上的核查正确。

---

## 2. 总体判断

**这是一次系统性、近乎全覆盖的高质量修订。** 上一轮 review 的 5 项 P0 + 9 项 P1，以及另一份 review 报告的 P1-1~7、P2-8~17，**几乎全部落地**，且新增了超出要求的内容。1.1 相比 1.0-draft 质量高一个台阶，**基本达到可基线化的条件**（还剩两个 P1 级精度问题，见 §5）。

值得单独指出的设计改进：

- **§20 三个正交状态机**（Negotiation Phase / Approval State / A2A Task State）——彻底解决 state/object 混用，顺带解决另一份 review 的 P1-7 全部状态机缺口。这是比"补边"更好的修法。
- **§9 Identifier Model**（negotiation_id / contextId / exchange_id / message_id / taskId / offer_id 各带职责、生成方、生命周期）——正是 P1-5 要求的标识符对照表。
- **§18 Digest 与幂等**（RFC 8785 JCS canonicalization + SHA-256 + `(sender_identity, message_id)` 主键 + duplicate-same/different-payload 分治 + retention）——正是 P1-6 要的机制。
- **§35 错误模型**、**§34 滥用缓解**、**§33 fan-out 隐私**、**§30 信任分级**——全是原文档没有、但开放网络必需的。
- **§39 不变量加 `[E]/[N]` 标注**、**§6 术语迁移表**、**§8 三个标识符关系**——把上一轮 P2 全数落实。
- **§44 子规范拆分声明**——明确 wire-level schema / 测试向量 / 状态转换表进 `kiwi-negotiation-protocol-1.0.md`，母文档职责边界终于干净。

---

## 3. 上一轮问题 → 本轮修复对照

### 3.1 本文件上一轮 review 的问题

| 上轮编号 | 问题 | 1.1 状态 | 位置 |
| --- | --- | --- | --- |
| P0-1 | ConditionalOffer 无 schema | ✅ 修复 | §12（field allowlist + 逻辑深度上限 + 禁 eval） |
| P0-2 | 核心对象无 JSON | ✅ 修复 | §11.4 / §13 / §15（另新增 §14 Withdraw/Decline） |
| P0-3 | 候选类型自相矛盾 | ✅ 修复 | §7（ActionCandidate 基类 → NegotiationActionCandidate 子类；DecisionCandidate 标 deprecated） |
| P0-4 | 审批顺序 + 缺前置重验 | ✅ 修复 | §21（明确"有意升级"+ RE-READ / RE-VALIDATE + §21.1 approval stale 绑定） |
| P0-5 | transport=a2a 不符 | ❌ 我方误判 | §27 正确，见 §1 更正 |
| P1-1 | 七域丢 Marketplace Conversation | ✅ 修复 | §22 八域，第 8 域限定 hosted |
| P1-2 | 恢复语义未定义 | ✅ 修复 | §25（8 步恢复流程 + Remote Ahead / Local Pending / Conflict 分治） |
| P1-3 | Message/Task 分界不清 | ✅ 修复 | §19 显式判定条件 |
| P1-4 | 价格表示不一致 | ✅ 修复 | §10.1 Money 单一表示 + 明确禁止 |
| P1-6 | OpenClaw/Hermes 误标继承 | ✅ 修复 | §1.2 单独列"已设计未实现" |
| P1-7 | direct 下 claim 模型未交代 | ✅ 修复 | §26 hosted/direct 双模型，direct 明确"不使用伪造 claim/heartbeat" |
| P1-8 | reputation 无来源 | ✅ 修复 | §29.3 来源 + `unknown` 默认 + "不能当 neutral 0.5" |
| P1-9 | selected_nonbinding 关系 | ✅ 修复 | §16 明确为 Buyer Task State，Merchant 不知情 |

### 3.2 另一份 review（`kiwi_a2a_v1-review-2026-08-05.md`）的问题

P1-1~7、P2-8~17 全部落地：

- envelope 用对外 namespace（§17）、三标识关系（§8.4）、UCP 三段式命名（§8.3）、vendor root capability 定位（§27.2）、标识符模型（§9）、幂等机制（§18）、三正交状态机（§20）
- buyer profile 宣告 + UCP-Agent header（§27.1）、spec/schema origin 绑定（§8.3）、协议错误码（§35）、反滥用（§34）、RFQ fan-out 泄露（§33）、消息签名（§31）、AgentDiscovery/CounterpartyChannel 职责分离（§36）、Checkout 标注 v1.1+（§3.4）

**唯一存疑的是 P2-15（disputed terms 仲裁者）**：1.1 直接删掉了 trust record 里的 `disputed terms count` 字段，改用 §29.3 的 reputation 来源模型——问题是随字段删除"消失"而非"回答"，建议在 reputation 子设计里明确一条 dispute 记录是"我方单方宣告"还是"双方确认"。

---

## 4. 外部规范事实核对（本次）

| 文档声称 | 实际规范 | 结论 |
| --- | --- | --- |
| UCP `transport: "a2a"`，endpoint 指向 Agent Card URL（§27） | UCP 定义 A2A transport 绑定，`services.dev.ucp.shopping.a2a.endpoint` 指 Agent Card URL | ✅ 正确（更正上轮误判） |
| A2A-over-HTTP 携带 `UCP-Agent` header（§27.1） | UCP A2A 绑定要求 Platform 携带 `UCP-Agent`（及 `X-A2A-Extensions`）header | ✅ 正确 |
| UCP capability 命名 `{reverse-domain}.{service}.{capability}` 三段式（§8.3） | UCP 强制三段式 capability 名 | ✅ 正确 |
| UCP 要求 spec/schema 托管在对应 domain authority（§8.3） | UCP 强制 spec/schema URL origin 与 namespace 绑定，platform 须校验 | ✅ 正确 |
| Agent Card `protocolBinding` 可选 JSONRPC / GRPC / HTTP+JSON（§28） | A2A 1.0 `protocolBinding` 枚举为 `HTTP+JSON` / `HTTP+SSE`；JSONRPC / GRPC 非枚举值 | ❌ 需改（见 P1-1） |

参考：UCP Profile / Embedded checkout（developers.google.com/merchant/ucp）；A2A Agent Card / Agent Discovery（github.com/a2aproject/A2A）。

---

## 5. 1.1 仍然存在的问题

### 5.1 P1（建议基线化前修）

**P1-1 · §28 Agent Card 的 `protocolBinding` 枚举与 A2A 1.0 不符**
示例写 `"protocolBinding": "JSONRPC"`，下文列"可选择 JSONRPC / GRPC / HTTP+JSON"。但 A2A 1.0 的 `protocolBinding` 枚举是 `HTTP+JSON`（流式变体 `HTTP+SSE`），`JSONRPC` 与 `GRPC` 都不是枚举值——JSON-RPC 是底层 wire 格式，绑定标识符是 HTTP+JSON。文档目标又是 A2A 1.0 互操作（§43 #1-2）。建议：示例改用 `HTTP+JSON`；若支持 gRPC 等，应表述为"非 A2A 的扩展 transport"，而不是 A2A binding 选项。

**P1-2 · §12 ConditionalOffer 求值结果的合并语义未定义**
§12.5 说多个 conditions 是"独立 rule，若同时命中必须确保结果无冲突，冲突→condition_conflict"。但：

- `then` 是整组替换还是逐字段 patch？（§12.1 示例 `then` 只含 unit_price，是部分覆盖）
- 多个 condition 同时命中但改**不同**字段时，合并规则是什么？（如 A 改 unit_price、B 改 fulfillment）
- 命中不同 condition 但改**同一**字段不同值，是否即 `condition_conflict`？
- `base_terms` 为空、无任何 condition 命中时用什么？

这与 §43 #8"ConditionalOffer 可以确定性求值"直接挂钩。至少要一句"合并 = 逐字段覆盖、同字段不同值即冲突"的规则，或在 §44 子规范强制项写明。

### 5.2 P2（可随子规范拆分解决）

- **P2-3 · §20 "v1.1 基线拆成三个正交状态机"**：frontmatter 已用 `doc_revision: 1.1` 区分产品版本，但正文仍写 "v1.1 基线"，而 target_product 是 v1.0——读者易读成"产品 v1.1 才拆"，与 §3.4 的 v1.1=Transaction Handoff 撞号。建议改"本修订基线"。
- **P2-4 · Withdraw/Decline 消息级与阶段级关系未定义**：§14 定义 withdraw/decline 是撤回 RFQ/Offer 的消息对象，§20 又有 WITHDRAWN/DECLINED 协商阶段。撤销当前唯一开放报价后，协商进 WITHDRAWN 终态还是回 OFFER_OPEN？DECLINED / WITHDRAWN / CANCELLED 的进入路径在 §20.1 的"例如"列表里缺失（含重新开启问题）——§44 子规范状态转换表必须钉死。
- **P2-5 · §28 示例与"至少需要描述"清单不符**：清单含 provider / securitySchemes / security / skills，示例只给了 name/description/version/supportedInterfaces/capabilities，四个必列字段一个未演示。
- **P2-6 · placeholder 域名不统一**：§17 envelope 用 `com.example.shopping.negotiation`，§8.4 用 `example.kiwi.shopping.negotiation`。都是占位，但同一个 namespace 两种写法会让实现者困惑，建议统一。
- **P2-7 · 对象计数不一致**：§3.3 列 9 个对象（含 Withdraw/Decline），§43 说"七类核心"，§44 列 10 个 schema（envelope+9）。"七类"缺定义（应为排除 withdraw/decline 的 7 个？），建议一处写明。
- **P2-8 · 未定义类型仍在**：`CounterpartyProfile`、`RemoteContext`、`ChannelResult`、`RemoteState`、`RemoteEvent`、`RemoteRef`、`NegotiationEnvelope`、`DiscoveryInput`、`ChannelOpenInput` 出现在接口签名但无定义。§0/§44 已把 schema 延期，可接受，但建议在 §36 接口旁标"由子规范定义"。
- **P3 · §36 `receive` 与 `subscribe?` 语义未区分**（拉 vs 推）；公开 transcript 的保留策略仍未提（上一轮 P3 遗留）。

---

## 6. 必须处理的过程问题

**1.1 基线目前只存在于 PDF，没有任何 markdown 源文件。** `docs/kiwi_a2a_v1.md` 仍是 v1.0-draft；全仓库 grep 不到"三个正交状态机 / RFC 8785 / hash-linked"等 1.1 独有内容的 md。影响：

- 基线无法走版本管理、无法 diff、无法让子规范引用行号；
- 后续 review（含本文件）只能锚在 PDF 上。

建议基线化动作 = **先把 1.1 内容落成 md（`docs/kiwi_a2a_v1.md` 新版本，或独立 `docs/kiwi-a2a-baseline-v1.1.md`），git 提交后再宣布基线**。PDF 只当交付物，不当事物的真相源。

---

## 7. 结论与下一步

1. **文档本身**：质量合格，可以推进基线化，前提是修掉两个 P1（§28 binding 枚举、§12 条件合并规则），并把 P2-3 / P2-7 这类措辞计数问题顺带清一遍。
2. **优先动作**：把 1.1 从 PDF 回落到 md 并提交（源头问题），否则后续一切 review 都悬空。
3. **然后**：按 §44 拆 `kiwi-negotiation-protocol-1.0.md` 子规范——条件合并语义（P1-2）、Withdraw/Decline 阶段语义（P2-4）、状态转换表都是子规范必须项。
