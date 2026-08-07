---
title: kiwi-a2a-baseline-v1.2（doc_revision 1.2）文档评审报告
version: v1.0
date: 2026-08-06
status: Completed
scope: Review of doc_revision 1.2 (Architecture Baseline)
supersedes-context: kiwi-a2a-rev1.1-review-2026-08-05.md
---

# kiwi-a2a-baseline-v1.2（doc_revision 1.2）评审报告

> 评审对象：doc_revision "1.2"（status: Architecture Baseline，1770 行）
> 评审时文件名为 `kiwi-a2a-baseline-v1.2.md`；评审当日已按本报告 P2-1 建议更名为 `docs/kiwi-a2a-architecture-baseline.md`（canonical 稳定名）。
> 评审方式：全文通读 + 与 `kiwi-a2a-baseline-v1.1.md` diff 比对 + 对照上轮评审报告逐项核验 + 旧文档归档标记实地核查
> 上轮结论索引：P2 三项（不变量回退、TargetRef 悬空、canonical source）、P3 十项

---

## 1. 总体结论

**通过，同意作为 Architecture Baseline。** v1.2 完整修复了上轮全部 3 项 P2 和全部可执行的 P3，新增内容（TargetRef 模型、条件求值语义、Dispute 分类、测试归属、外部标准 pin）质量高且与既有部分自洽。剩余 1 项 P2（canonical 文件名与 §42 规范树不一致）和若干 P3 不影响架构决策，建议随下一轮编辑处理后无需再次评审。

---

## 2. 上轮 P2 修复核验（3/3 通过）

| # | 原问题 | 修复位置 | 结果 |
| --- | --- | --- | --- |
| P2-1 | 安全不变量回退三条 | §36 扩至 24 条：#11（Remote Agent 不得获得任意本地工具执行权）、#12（Remote Content 视为 untrusted input）、#13（Remote Message 不得直接写入 Principal Memory）、#24（Agent Card / UCP Profile 不得含静态 secret）全部补回；新增 §4.5 独立设计原则；**§36 末尾新增"删除不变量必须在 changelog 显式记录理由"的治理规则** | ✅ 超出预期 |
| P2-2 | Withdraw/Decline 的 `target_id` 悬空 | §9.7 新增 Target Reference Model：`target_ref = {message_id, offer_id?}`，message_id 通用、offer_id 复核、两者 MUST 指向同一 Ledger 对象、negotiation 级动作用 envelope `negotiation_id`；§9.6 补 CounterOffer 自己的 `offer_id`；§14 用 `scope` 显式表达撤回/拒绝范围，"不能通过 target 类型猜测" | ✅ 设计正确 |
| P2-3 | canonical source 不明 | frontmatter 增加 `canonical_source: markdown` 与 `supersedes: "doc_revision 1.1"`；§0 声明 Markdown 唯一规范源；§6 术语表增加"旧 PDF 基线 → Markdown canonical source"；§42 定义规范树。旧 `kiwi_a2a_v1.md` 已实地确认标记 `Superseded / 已归档` | ✅（残留问题见新 P2-1 / P3-1） |

## 3. 上轮 P3 修复核验（全部通过）

- "七类"数量不符 → §3.3 / §11 / §41#7 统一为**九类核心 Negotiation Objects**，并显式说明 `accept_nonbinding` / `cancel` / `clarification_response` 是协议动作、不参与计数 ✅
- 示例域名不统一 → §8.2 / §8.3 / §8.4 / §26 全部统一为 `kiwi.example` / `example.kiwi.shopping.negotiation` ✅
- `UCP-Agent` 适用范围 → §25.1 区分 HTTP binding 与非 HTTP binding（GRPC），wire mapping 交由子规范钉死 ✅
- Agent Card 示例缺字段 → §26 补齐 `provider` / `securitySchemes` / `security` / `skills` ✅
- `buyer.segment` 披露张力 → §12.3 Disclosure Interaction + §29 末句，condition 字段先过 DisclosurePolicy ✅
- "首选完整 proposed_terms" 措辞弱 → §12.2 升级为 MUST 级 Merge Semantics（完整 `then_terms`、冲突即 `condition_conflict`、禁止隐式字段 merge、LLM 不得选择冲突结果）✅
- 外部标准基线附录丢失 → §43 pin A2A v1.0.x / UCP 2026-04-08 / RFC 8785 / SHA-256 / HTTP Message Signatures / OAuth-OIDC-mTLS，并明确 AP2、ACP-Commerce 属于 v1.1+ ✅
- 测试矩阵未安置 → §40 Testing Ownership 两层拆分（runtime 测试计划 + 协议 conformance vectors）✅
- §36 "receive" 措辞 → §33 职责与接口对齐，并说明 subscribe/getState 分工；接口类型显式声明不在本文冻结 ✅
- Ledger retention → §22 补充删除策略与幂等证据的分层设计 ✅
- Dispute 仲裁 → §27 增加 `local_asserted / mutually_acknowledged / third_party_adjudicated` 三级分类，"不得把本地单方标记伪装成全球事实" ✅

## 4. v1.2 新增内容质量评估

- **§4.5 Remote Content Is Untrusted**：四条 MUST/MUST NOT 具体可验证，与 §36 #12、§41 #17/#18 三处自洽。
- **§13 Envelope 冲突处理**："structured payload 与 public_message 冲突时不得由模型静默修复，返回错误或转人工"，并在 §32 增加 `structured_text_conflict` 错误码——闭环完整。
- **§14.4 Reopen 规则**：五个终态明确 terminal，重谈必须新 `negotiation_id`——消除了旧版状态机的一类歧义。
- **§32 错误码**：新增 `offer_unknown`、`terms_digest_mismatch`、`reconciliation_required`、`structured_text_conflict`，与 TargetRef、恢复流程形成呼应。
- **§41 完成定义**：25 → 27 条，新增 #17/#18 与不变量同步，无漂移。

---

## 5. 新发现问题

### P2-1 §42 规范树文件名与实际文件名不一致

§42 写明 canonical 文件为：

```text
docs/kiwi-a2a-architecture-baseline.md   # canonical architecture source
```

但实际文件是 `kiwi-a2a-baseline-v1.2.md`。这带来两个问题：

1. 按 §42 找不到 canonical 文件——刚建立的"唯一规范源"机制在第一天就自相矛盾；
2. 版本号进入文件名意味着每次修订都会改 canonical 路径，所有外部引用（子规范、测试计划、代码注释）都要跟着改。

建议：canonical 文件改用稳定名（如 §42 所写的 `kiwi-a2a-architecture-baseline.md`），修订号只保留在 frontmatter 的 `doc_revision`；旧版本如需留存，放入 `docs/archive/` 或以 git tag 区分。

**解决记录（2026-08-06）**：已执行。文件更名为 `docs/kiwi-a2a-architecture-baseline.md`，与 §42 规范树一致；`doc_revision: "1.2"` 保留在 frontmatter。

### P3-1 归档标记未闭环

- `kiwi-a2a-baseline-v1.1.md` 未标记 superseded（frontmatter 仍是 `status: Proposed Architecture Baseline`，无 `superseded_by`）——v1.2 §0 自己规定的动作没有执行到这份文件上；
- `kiwi_a2a_v1.md` 的 `superseded_by` 指向 v1.1，而 v1.1 本身已被取代。建议归档指针一律指向当前 canonical 文件，而非形成链条。

### P3-2 "KNP" 缩写未定义

§9.4 起多处使用 "KNP wire message"、"KNP/1.0"，但全文从未正式引入 KNP = Kiwi Negotiation Protocol 的缩写。建议在 §0 或 §3.3 首次出现处定义。

### P3-3 Envelope `capability` 字段与 §8.3 的映射缺一句话

§13 把 v1.1 的 `protocol` 字段改为 `capability`，但全文没有一句话说明该字段的取值就是 §8.3 的 UCP vendor capability namespace。另外，纯 A2A 部署（counterparty 无 UCP Profile，只有 Agent Card）下 `capability` 填什么，未说明。建议各补一句。

### P3-4 CounterOffer 的完整 `proposed_terms` 指引被静默移除

v1.1 §11.4 有"v1.0 首选完整 proposed_terms，避免 patch 语义歧义"（当时评审指出措辞太弱）。v1.2 §12.2 把 MUST 级 merge 语义给了 ConditionalOffer 的 `then_terms`，但 CounterOffer 是否同样携带完整 `proposed_terms` 不再有任何表述。建议显式规定或显式 defer 给 KNP/1.0。

### P3-5 §31 "至少 SHOULD 支持" 规范语气矛盾

"至少"表达下限，"SHOULD"表达可选，两者组合语义含糊。作为反滥用的最低基线，建议拆分：核心机制（rate limit / payload-size / replay protection）用 MUST，其余用 SHOULD。

### P3-6 §9.3 `exchange_id` 仍缺生成/沿用规则

"标识一轮语义交换，例如 RFQ→Offer" 未说明由谁生成、响应方是否沿用。一句话即可（如"由交换发起方生成，响应消息沿用同一 exchange_id"），细节留给子规范。

### P3-7 frontmatter `date` 未随修订更新

仍为 2026-08-05，文件实际修改于 2026-08-06。建议每次修订同步 bump，或增加 `last_modified`。

### P3-8 §26 示例 `"securitySchemes": {}, "security": []`

公开 Merchant endpoint 的示例给出空安全配置，容易被实现者照抄。建议示例至少展示一种 scheme，或注释说明"空值仅为结构示意"。

---

## 6. 结论与建议

1. 修 P2-1（canonical 文件名稳定化）后即可按 §42 推进规范树落地；
2. P3-1 归档标记是与 P2-1 同一件事的两面，建议一并处理（v1.1.md 标记 superseded、旧 draft 指针改指 canonical）；
3. 其余 P3 无需阻塞基线，可在拆子规范时顺带修；
4. 下一步按 §42 启动 `docs/protocol/kiwi-negotiation-protocol-1.0.md`，重点把 TargetRef、exchange_id、envelope `capability` 三处的字段级语义钉死。

---

## Appendix — 评审记录

- 评审日期：2026-08-06（文件修改时间 2026-08-06 06:40）
- 对比基线：`kiwi-a2a-baseline-v1.1.md`（diff 约 3300 行，其中大部分为格式规范化：`##`→`#`、列表改 code block；语义变更已全部纳入本报告核验范围）
- 实地核查：`kiwi_a2a_v1.md` 已标记 Superseded；`kiwi-a2a-baseline-v1.1.md` 未标记；rev 1.1 PDF 仍在 `docs/` 下
- 外部协议事实未重复核查，沿用上两轮结论（A2A 1.0 well-known 路径、UCP 2026-04-08、namespace 治理规则均准确）
- 本报告与 `kiwi_a2a_v1-review-2026-08-05.md`、`kiwi-a2a-rev1.1-review-2026-08-05.md` 构成完整三轮评审链
