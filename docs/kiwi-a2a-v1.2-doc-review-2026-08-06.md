---
title: Kiwi A2A Agent Commerce Network 基线 v1.2 文档评审
doc_revision: "1.2"
reviewed: 2026-08-06
type: research-note
topic: kiwi-a2a-baseline-v1.2.md（doc_revision 1.2）文档评审
status: review
tags: [doc-review, kiwi, a2a, negotiation, architecture]
---

# Kiwi A2A Agent Commerce Network 基线 v1.2 文档评审

**评审对象**：`docs/kiwi-a2a-baseline-v1.2.md`（`doc_revision: "1.2"`，`target_product: Kiwi A2A v1.0`，2026-08-05，44 章）。

**评审方法**：全文通读 + 与 v1.1 基线逐节 diff + 与两份既有 review（`kiwi-a2a-v1.1-doc-review-2026-08-05.md`、`kiwi-a2a-rev1.1-review-2026-08-05.md`）逐项核验 + 与 KNP 子规范（`docs/kiwi-negotiation-protocol-1.1.md`）跨文档对照 + 外部规范事实独立复核（A2A 1.0 官方 SDK 源码）+ 代码核对（§1.1 已实现声明、§37 前置整改项）。

**评审范围**：只读，未修改任何文件；本报告为唯一产出。

---

## 1. 重要更正声明

**撤回上一轮 review 的一个判断（v1.1 doc-review 的 P1-1 · Agent Card `protocolBinding` 枚举）。**

- 上轮声称："A2A 1.0 的 `protocolBinding` 枚举是 `HTTP+JSON`（流式变体 `HTTP+SSE`），`JSONRPC` 与 `GRPC` 都不是枚举值"。
- **该判断错误。** 本次直接核对 A2A 官方 Python SDK 源码：
  - `src/a2a/utils/constants.py`：`TRANSPORT_JSONRPC = 'JSONRPC'`、`TRANSPORT_HTTP_JSON = 'HTTP+JSON'`、`TRANSPORT_GRPC = 'GRPC'`，注释明确 *"These match the protocol binding values used in AgentCard"*。
  - `src/a2a/types/a2a_pb2.py`（A2A 1.0 protobuf schema）：含 `supportedInterfaces`（AgentCard 必填字段）与 `protocolBinding`（AgentInterface 字符串字段）；schema 中**不存在** `HTTP+SSE` 枚举。
- 因此 v1.2 §3.1 / §26 的 "A2A 1.0 core bindings: `JSONRPC` / `GRPC` / `HTTP+JSON`" 与示例 `"protocolBinding": "JSONRPC"` 是**正确的**。上轮 P1-1 系误判，不要求修改文档。
- 建议：按上一轮对 P0-5（transport=a2a）误判的勘误方式，在 v1.1 两份评审报告中标注该更正。

---

## 2. 总体判断

**达到可基线化质量，无阻塞性 P1。**

v1.2 相对 v1.1 是"收尾 + 钉死"型修订，不是新架构。上轮 v1.1 doc-review 的遗留项除一项误判（P1-1）外**全部落地**；`rev1.1-review` 的三项遗留（P2-1 安全不变量回退、P2-2 target_id 悬空、P2-3 双源并存）处理得尤其干净。上轮 P2/P3 中"待子规范钉死"类问题，v1.2 基本都给出了明确去向。

值得单独指出的设计改进：

- **§9.7 Target Reference Model**：`message_id` 通用引用 + offer-like 可选 `offer_id` + 同指同一 Ledger 复核，一次解决 RFQ / CounterOffer 无自身 id 导致的悬空引用问题（上轮 P2-2）。
- **§12.2 Merge Semantics**：五条求值规则 + 明确禁止隐式逐字段 merge + `base_terms` 必须可单独求值。把上轮 P1-2 从"需要一句话"钉成了规范级规则，且与 KNP §13.6 七条规则逐条对齐。
- **§14 Withdraw/Decline/Cancel 的 `scope` 语义 + §14.4 Reopen**：`OFFER_OPEN → OPEN / → WITHDRAWN`、terminal 不可在同一 `negotiation_id` 下重开——状态转换语义闭环，与 KNP §21.2 转换表一致。
- **§36 Security Invariants 20→24 条**：`rev1.1-review` 指出的三条回退（远端工具执行权 / Remote Content untrusted / Agent Card 静态 secret）全数补回（#11 / #12 / #24）。
- **§37 可靠性前置整改 + §40 测试归属 + §42 子规范树 + §43 外部标准基线**：把"欠账"、"测试归谁"、"pin 哪些外部版本"全部写进基线，文档的可执行性明显提高。

---

## 3. 上轮问题 → 本轮修复对照

### 3.1 v1.1 doc-review 的遗留项

| 上轮编号 | 问题 | v1.2 状态 | 位置 |
| --- | --- | --- | --- |
| P1-1 | Agent Card `protocolBinding` 枚举不符 | ❌ 我方误判，撤回 | §3.1 / §26 正确（见 §1 更正） |
| P1-2 | ConditionalOffer 合并语义未定义 | ✅ 修复 | §12.2 五条规则 + 禁隐式 merge；KNP §13.6 |
| P2-3 | "v1.1 基线"措辞与产品版本撞号 | ✅ 修复 | §18 改"本修订基线" |
| P2-4 | Withdraw/Decline 阶段语义未钉死 | ✅ 修复 | §14 + §14.4 + KNP §21.2 转换表 |
| P2-5 | Agent Card 示例缺字段 | ✅ 修复 | §26 补齐 provider / securitySchemes / security / skills |
| P2-6 | 占位域名不统一 | ◐ 基线内已统一 | 基线上已统一 example.kiwi.*，但未传导到 KNP 子规范（见新 P2-1） |
| P2-7 | 对象计数不一致（七类/九类） | ✅ 修复 | 全文统一"九类" |
| P2-8 | 未定义类型仍在 | ✅ 处理 | §33 显式"由子规范/实现接口定义" |
| P3 | `receive` 措辞 / transcript retention | ✅ 修复 | §33 / §22 |

### 3.2 rev1.1-review 的遗留项

| 编号 | 问题 | v1.2 状态 | 位置 |
| --- | --- | --- | --- |
| P2-1 | 安全不变量回退三条 | ✅ 修复 | §36 补回（#11 远端工具执行权 / #12 untrusted / #24 Agent Card secret） |
| P2-2 | `target_id` 引用悬空 | ✅ 修复 | §9.7 TargetRef + KNP §17.1 Target Reference |
| P2-3 | 双文档并存 canonical source 不明 | ◐ 部分 | §0 已声明 markdown canonical、PDF 已删；但版本链未闭合（见新 P2-3 / P2-4） |

---

## 4. 外部规范事实核对（本轮独立复核）

| 文档声称 | 事实 | 结论 |
| --- | --- | --- |
| §3.1 / §26 "A2A 1.0 core bindings: JSONRPC / GRPC / HTTP+JSON" | a2a-python `constants.py`：`TRANSPORT_JSONRPC='JSONRPC'`、`TRANSPORT_HTTP_JSON='HTTP+JSON'`、`TRANSPORT_GRPC='GRPC'`，注释 "match the protocol binding values used in AgentCard" | ✅ 正确 |
| §26 Agent Card 用 `supportedInterfaces` 声明 binding | A2A 1.0 AgentCard 必填字段 `supportedInterfaces`（proto 中 field option required） | ✅ 正确 |
| §25 UCP `transport: "a2a"` endpoint→Agent Card URL | UCP 定义 A2A transport 绑定，`services...a2a.endpoint` 指 Agent Card URL | ✅ 沿用上轮已核实结论 |
| §8.3 UCP capability `{reverse-domain}.{service}.{capability}` | UCP 强制三段式命名 | ✅ 沿用上轮已核实结论 |

---

## 5. 新发现问题

### 5.1 P2（建议基线化提交前 / 子规范冻结前处理）

**P2-1 · UCP capability namespace 跨文档不一致**

基线 §8.3 全部示例统一为 `example.kiwi.shopping.negotiation`，但 KNP 子规范（`docs/kiwi-negotiation-protocol-1.1.md`）§4.3 示例、§4.4 test vectors、§8 envelope 示例用的都是 `com.example.shopping.negotiation`。envelope 的 `capability` 字段每个 wire 消息都携带，两个文档给出不同字符串，实现者会直接对不上。上轮 P2-6 只修了基线这一侧。建议：以基线的 `example.kiwi.*` 为准，把子规范的示例统一改掉（均为占位符，生产前本就要替换）。

**P2-2 · 母文档与子规范 TargetRef wire 形状矛盾**

基线 §9.7 示例是嵌套对象：

```json
{ "target_ref": { "message_id": "msg_...", "offer_id": "off_..." } }
```

KNP §17.1 是扁平字段：

```json
{ "target_message_id": "msg_...", "target_offer_id": "off_..." }
```

语义一致（`message_id` 通用引用、offer-like 增加 `offer_id`、两者同指同一 Ledger 对象、不一致 → `state_conflict`），但具体 JSON 形状两个文档互相矛盾。基线把精确 wire schema 延期到子规范，可接受；但母文档不能给出与子规范相悖的示例。建议：基线 §9.7 示例改为扁平字段，或加一句"精确 wire schema 以子规范为准"。

**P2-3 · 协议文档版本链未闭合（上轮 P2-3 的结构问题转移到协议层）**

- `docs/kiwi-negotiation-protocol-1.0.md`（已提交）与 `docs/kiwi-negotiation-protocol-1.1.md`（未提交修订版）**并存**，两份都叫"Kiwi Negotiation Protocol 1.0"（协议版本号均为 1.0，doc_revision 分别为 1.0 / 1.1）；
- 基线 §42 引用的路径是 `docs/protocol/kiwi-negotiation-protocol-1.0.md`——目录（`docs/` vs `docs/protocol/`）与当前文件名（`1.1`）都不匹配。

这正是基线 §0 自己声明要消灭的"双源真相"问题，只是转移到了协议层。建议：把 1.1 内容合入正式文件名提交，旧 1.0 文件标记 superseded 或删除。

**P2-4 · 架构基线版本链未闭合**

v1.2 frontmatter 声明 `supersedes: "doc_revision 1.1"`，但：

- `kiwi-a2a-baseline-v1.1.md` 自身仍是 `status: Proposed Architecture Baseline`，无被取代标记；
- `kiwi_a2a_v1.md` 的 `superseded_by` 只指向 v1.1，链上没有 v1.2；
- `git status`：v1.2 与 protocol-1.1 均为 untracked，PDF 删除（` D docs/Kiwi-A2A-Agent-Commerce-Network.pdf`）未提交。

建议一次提交完成版本链闭合：提交 v1.2 + protocol-1.1 + PDF 删除，在 v1.1 文件头加 superseded 标记，更新 superseded 链。

### 5.2 P3

- **P3-1 · 标题层级回退**：v1.2 把全部顶级章节升为 `#`（H1），而文档标题也是 `#`，全篇出现 45 个 H1、无层级（v1.1 是标题 H1、章节 H2、子节 H3）。影响 TOC / outline 工具。建议章节用 `##`。
- **P3-2 · "九类"与 KNP 消息清单计数口径不同**：基线 §11 说九类核心对象 + 三个生命周期动作（accept_nonbinding / cancel / clarification_response）不计入对象；KNP §2 scope 把 AcceptNonbinding 列为规范定义的 message，Appendix A 也有 `accept-nonbinding.schema.json`。实质一致，但两文档计数口径不同，建议统一表述（如"九类业务对象 + 三个生命周期动作，其中 accept_nonbinding 有独立 schema"）。
- **P3-3 · 幂等 retention 双锚点**：基线 §17 "至少覆盖 `max(offer validity, task lifetime, 24 hours)`"；KNP §20.5 "completed idempotency records ≥24 hours after negotiation becomes terminal"。可并存但锚点不同，建议交叉引用说明两者关系。
- **P3-4 · §37 P0 无归属与回归测试**：claim escape recovery / fake claim semantics 两项 P0 是诚实的前置整改，但未指定追踪位置 / 责任人，§40.1 测试计划也未点名这两项的回归用例。建议测试计划显式列出 P0 回归测试（代码 `src/cli.ts` 已有"abandon unsettled claim、never complete it"的语义，可转化为断言）。
- **P3-5 · Agent Card 顶层 `extensions` 未演示**：§26 bullet 清单含 `extensions`，示例 JSON 只在 `capabilities.extensions` 出现，顶层字段未演示。（轻微）

---

## 6. 与代码现状的对照（非阻塞）

- §1.1 "已实现"声明与代码一致：AgentKernel（`src/agent/kernel.ts`）、Principal Memory（`src/agent/memory/`）、Private Vault（`src/agent/memory/vault.ts`）、Task Scheduler（`src/agent/buyer/scheduler.ts`）、Credential Broker（`src/agent/merchant/credential-broker.ts`）、merchant 写 ActionCandidate（`src/agent/merchant/action-candidate.ts`）、Buyer `selected_nonbinding`（`src/agent/buyer/buyer-tools.ts`）均在；OperatorController 的 manual/supervised/autopilot 与 `src/operator/`、`mode.ts` 对应。
- §1.2 "OpenClaw / Hermes ACP-Runtime Adapter 已设计但尚未实现"与 `docs/external-agent-adapters-v0.2.md` 的"状态：设计稿，0.1.0 未实现"一致。
- §37 前置整改项与代码结构对应：claim / heartbeat（`src/runtime/heartbeat.ts`）、`--once`（`src/cli.ts`，含"abandon unsettled claim"注释）、日志脱敏（`redaction_level`，`memory/schema.ts`）、文件权限（`agent-db.ts` 的 `0o700` / `0o600`）均存在。P0 两项是运行时行为层面的已知问题，基线诚实列出；后续以 §40.1 测试计划钉住即可。

---

## 7. 必须处理的过程问题

1. **一次提交闭合版本链**：v1.2 基线与 protocol-1.1 均为未提交文件，PDF 删除未提交。基线化动作 = 提交 v1.2 + protocol-1.1 + PDF 删除，并给 v1.1 文件加 superseded 标记（见 P2-3 / P2-4）。
2. **子规范对齐后再冻结**：capability namespace（P2-1）与 TargetRef wire 形状（P2-2）与母文档对齐后，再宣布 schema 冻结。
3. **上轮误判勘误**：v1.1 doc-review 的 P1-1 结论已证伪，建议在两份 v1.1 评审报告中标注更正（参照上一轮对 P0-5 的更正声明处理方式）。

---

## 8. 结论与下一步

1. **文档本身**：达到基线质量，无阻塞性 P1。v1.2 完成了 v1.1 遗留的收尾；上轮唯一"未修"项（P1-1）实为上轮误判，不构成缺陷。
2. **优先动作**：提交 v1.2 + 对齐子规范两处 wire 示例（P2-1 / P2-2）+ 闭合版本链（P2-3 / P2-4）。均为几分钟的手续问题，做完即可宣布基线。
3. **然后**：v1.2 基线化后，按 §42 规范树落地 `docs/protocol/kiwi-negotiation-protocol-1.0.md` + `schemas/` + `test-vectors/`，并让 §40.1 测试计划点名 §37 的两项 P0 回归用例。
