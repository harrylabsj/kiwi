---
title: Kiwi-A2A-Agent-Commerce-Network.pdf (rev 1.1) 文档评审报告
version: v1.0
date: 2026-08-05
status: Completed
scope: Review of docs/Kiwi-A2A-Agent-Commerce-Network.pdf (doc_revision 1.1, Proposed Architecture Baseline)
supersedes-context: kiwi_a2a_v1-review-2026-08-05.md
---

# Kiwi-A2A-Agent-Commerce-Network.pdf（rev 1.1）评审报告

> 评审对象：`docs/Kiwi-A2A-Agent-Commerce-Network.pdf`（doc_revision "1.1"，status: Proposed Architecture Baseline，48 页）
> 评审方式：基于 `pdftotext` 提取文本全文通读；对照上一轮评审报告（`kiwi_a2a_v1-review-2026-08-05.md`）逐项核验修复情况；外部协议事实沿用上一轮已核查结论
> 上一轮结论索引：P1 共 7 项、P2 共 10 项、P3 若干

---

## 1. 总体结论

**本版达到架构基线（Baseline）质量，建议处理完 §4 的两个 P2 后正式基线化。**

rev 1.1 是对上一轮评审的全面回应：P1 七项全部修复，P2 十项中九项修复。状态机正交拆分（§20）、Identifier Model（§9）、Digest/幂等机制（§18）、领域错误模型（§35）四块新增内容设计扎实，不是打补丁而是结构性改进。

---

## 2. 上一轮 P1 修复核验（7/7 通过）

| # | 原问题 | 修复位置 | 结果 |
| --- | --- | --- | --- |
| P1-1 | Envelope `protocol` 字段违反 §8.1 命名规则 | §17：对外 Envelope 改用公网 namespace（`com.example.shopping.negotiation`），内部名仅作模块标识 | ✅ |
| P1-2 | 三个协议标识符关系未声明 | §8 三层划分（内部模块 / A2A Extension URI / UCP Vendor Capability）+ §8.4 映射关系 | ✅ |
| P1-3 | UCP capability 命名非三段式 | §8.3 强制 `{reverse-domain}.{service}.{capability}` | ✅ |
| P1-4 | "extension" 与 UCP 术语冲突 | §27.2 明确为 Vendor Root Capability，不带 `extends` | ✅ |
| P1-5 | ID 模型缺失 | §9 定义 `negotiation_id` / `contextId` / `exchange_id` / `message_id` / `taskId` / `offer_id` | ✅ |
| P1-6 | 幂等与 digest 只有原则没有机制 | §18：RFC 8785 canonicalization、digest 计算范围、幂等主键 `(sender_identity, message_id)`、重复同 payload / 不同 payload 的分别处理、retention 下限 | ✅ 设计完整 |
| P1-7 | 状态机六处缺口 | §20 拆成 Negotiation Phase / Approval State / A2A Task State 三个正交状态机；Withdraw/Decline 成为协议对象（§14）；HumanRequired 不再伪装成协商状态 | ✅ 优于逐边修补的解法 |

## 3. 上一轮 P2/P3 修复核验

**P2：9/10 修复。**

| # | 原问题 | 修复位置 | 结果 |
| --- | --- | --- | --- |
| P2-8 | A2A 模式下 buyer profile 宣告未定义 | §27.1：A2A-over-HTTP 携带 `UCP-Agent` | ✅（边界见新 P3） |
| P2-9 | spec/schema URL origin 绑定未提及 | §8.3 + roadmap v0.6 "spec/schema hosting" | ✅ |
| P2-10 | 无协议级错误模型 | §35：16 个领域错误码，且明确"错误 ≠ Decline" | ✅ |
| P2-11 | `selected_nonbinding` 无定义 | §16：归为 Buyer Task State，非协议状态；Merchant 无需感知 | ✅ 处理得当 |
| P2-12 | discover() 职责重叠 | §36：AgentDiscovery 负责发现，CounterpartyChannel 只负责 open/send/state/subscribe/close | ✅ |
| P2-13 | 消息级签名缺席 | §31：区分 integrity / authentication / non-repudiation；复用 HTTP Message Signatures + profile signing_keys；Agent Card JWS 由 TrustPolicy 决定 | ✅ |
| P2-14 | 缺反滥用设计 | §34：八类威胁 + 八项机制；roadmap v0.7；完成定义 #21 | ✅ |
| P2-15 | disputed terms 仲裁者未定义 | 旧字段移除；§29.3 reputation 改为多来源 + "unknown 不得当成 neutral 0.5" | ✅ 以移除方式解决，可接受 |
| P2-16 | Checkout Handoff 范围标注 | §3.4 明确归入 v1.1+ Transaction Handoff | ✅ |
| P2-17 | RFQ fan-out 需求信号泄露 | §33：max_recipients / minimum_trust / anonymous_first_round / 两轮披露示例 | ✅ 设计好 |

**P3 修复要点**：CounterOffer JSON 示例补齐（§11.4）、`actor` 枚举定义且 system 不得伪装交易主体（§17）、"默认 Private" 措辞修正（§4.4）、Ledger retention 与不保存 CoT/私钥（§18.6、§24.1）、术语迁移表显式废弃 `NegotiationCandidate`（§6，确认"上一版文档误引入"）。

---

## 4. 新发现问题

### P2-1 安全不变量清单回退三条（§39）

新版 20 条不变量的 `[E]/[N]` 标注是改进，但旧版三条不变量被移除且未说明理由：

- **"外部 Agent 不获得本地工具任意执行权"**（旧 #3）。新 #3 "ReasoningBackend 不拥有 Commerce 写权限"约束的是内部 backend，与"远端 Agent 不得触发本地工具执行"是两个不同主体，不能互相替代。
- **"远端内容始终视为 untrusted input"**（旧 #9）。这是 prompt injection 防御的第一原则，§34 的反滥用机制覆盖不了它。
- **"Agent Card 不放静态 secret"**（旧 #18）。

安全基线删减不变量必须显式记录理由；无特别理由则建议补回。

### P2-2 Withdraw/Decline 的 `target_id` 引用悬空（§14 vs §11 vs §9）

§14.1 允许 Withdraw 撤回 RFQ / Offer / CounterOffer，但：

- RFQ（§11.2 示例）**没有 id 字段**；
- CounterOffer（§11.4 示例）**没有自身 id 字段**（仅有 `responding_to_offer_id`）；
- §9 Identifier Model 只定义了 `offer_id`，未定义 `target_id` 的取值空间。

三类可撤回对象中两类没有可引用的 id。二选一：给所有可撤回/可拒绝对象定义对象级 id；或规定 `target_id` 引用 envelope 的 `message_id`。母文档至少应指出该问题并指定方向，字段细节留给子规范（§44）。

### P2-3 新旧两份文档并存，canonical source 不明

`docs/` 下同时存在 `kiwi_a2a_v1.md`（旧 v1.0-draft）与本 PDF（rev 1.1 基线）：

- 旧 md 未标注 superseded；
- PDF（1.3 MB 二进制）不利于 git diff 与协作评审。

建议：以 markdown 为唯一源、PDF 为导出物；在旧 `kiwi_a2a_v1.md` 头部标注"已被 rev 1.1 取代"或直接移除。

---

## 5. P3 小问题

- **完成定义 #7 数量不符（§43）**：写"七类核心 Negotiation Objects"，但 §3.3 列了 9 类对象（含 Withdraw、Decline），§44 schema 目录也是 9 个对象 schema。改为"九类"，或注明"七类核心 + Withdraw/Decline"。
- **示例域名不统一**：§8.3 / §17 用 `com.example.shopping.negotiation`（对应 example.com），§8.4 / §28 用 `kiwi.example`（reverse-domain 应为 `example.kiwi.*`）。两个示例各自合法，并列出现会误导。建议全文统一使用 `kiwi.example`。
- **`UCP-Agent` 适用范围（§27.1）**：UCP 官方仅为 HTTP / MCP transport 定义 profile 宣告机制；A2A-over-HTTP 携带 `UCP-Agent` header 是 Kiwi 的合理延伸，但 §28 同时允许 GRPC binding（无 HTTP header）。建议注明"其他 binding 的宣告机制由子规范定义"。
- **"Remote Message 不得直接成为 Principal Memory" 规则丢失**：旧版 §13 的记忆治理规则在新版八个状态域（§22）与不变量（§39）中均无对应物，建议补回。
- **§28 Agent Card 示例缺字段**：bullet 要求 `skills`、`securitySchemes`，示例 JSON 均未出现。
- **`buyer.segment` 进入 condition 白名单（§12.4）**：与 §4.4 / §32 披露控制存在张力——merchant condition 引用 `buyer.segment` 意味着该字段已被披露。建议交叉引用 NetworkDisclosurePolicy。
- **§11.4 "v1.0 首选完整 proposed_terms"**："首选"对基线文档太弱，子规范应定为 MUST。
- **外部标准版本基线附录丢失**：旧版 Appendix B 列有 A2A 1.0.0 / UCP 2026-04-08 / AP2 / ACP-Commerce 基线，新版无任何外部引用清单。基线文档应 pin 外部依赖的版本与 URL。
- **测试矩阵未安置**：旧版 §31 六类测试（unit / interop / UCP / legacy / security / reliability）在新版仅以完成定义 #20–22 形式存在，§44 把 test vectors 交给子规范。建议明确完整测试计划的归属文档。
- **§36 措辞**：CounterpartyChannel 职责列表含 "receive"，接口中无对应方法（subscribe / getState 可覆盖），对齐措辞即可。

---

## 6. 建议处理顺序

1. **P2-1 补回三条安全不变量；P2-2 明确 `target_id` 模型**——影响安全基线完整性与子规范起点。
2. **P2-3 解决文档归属**，避免双源真相。
3. P3 随下一轮编辑顺带修复。
4. 完成后将文档状态从 Proposed 转为 Baseline，并按 §44 拆出 `docs/protocol/kiwi-negotiation-protocol-1.0.md` 子规范。

---

## Appendix A — 本轮评审方式说明

- PDF 文本经 `pdftotext -layout` 提取（2833 行），图示以 ASCII 形式包含在文本中，无遗漏风险；如 PDF 中存在纯图片未提取内容，本报告未覆盖。
- 外部协议事实（A2A 1.0.0 well-known 路径、UCP 2026-04-08 spec family、`/.well-known/ucp`、A2A transport binding、UCP namespace 治理规则）沿用上轮评审已完成的核查，本轮未重复验证，结论仍有效。

## Appendix B — 与上一轮评审报告的关系

本报告与 `kiwi_a2a_v1-review-2026-08-05.md` 配套使用：前者定义问题基线，本报告核验修复并登记新发现。rev 1.1 文档基线化后，两份评审报告均可归档。
