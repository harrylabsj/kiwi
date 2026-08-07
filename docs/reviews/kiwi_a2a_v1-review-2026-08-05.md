---
title: kiwi_a2a_v1.md 文档评审报告
version: v1.0
date: 2026-08-05
status: Completed
scope: Review of docs/kiwi_a2a_v1.md (v1.0-draft)
---

# kiwi_a2a_v1.md 文档评审报告

> 评审对象：`docs/kiwi_a2a_v1.md`（v1.0-draft，2026-08-05）
> 评审方式：全文通读 + 内部一致性交叉核对 + 外部协议引用事实核查

---

## 1. 总体评价

这是一份质量很高的母文档：

- **Scope 纪律极好**。v1.0 截止于非绑定共识的边界贯穿全文，§26 安全不变量、§27 产品边界、§32 完成定义三处互相印证，无漂移。
- **Fail-closed 原则落实具体**，不是口号而是逐条可验证的不变量。
- **ACP-Runtime / ACP-Commerce 的术语拆分**解决了真实的混淆点，且全文执行了一致（已 grep 验证，无裸 `ACP` 使用，line 270 为元讨论，可接受）。
- **§0 与 Appendix A 的继承关系**让评审和后续实现的溯源成本大幅降低。
- **外部协议引用全部准确**（见 §2 核查结果）。

以下问题按严重度分级：P1 = 与外部规范冲突或内部矛盾，建议基线化前修复；P2 = 应当修复的设计/完整性问题；P3 = 文字与小问题。

---

## 2. 外部引用事实核查结果

| 文档声明 | 核查结果 | 来源 |
| --- | --- | --- |
| A2A 1.0.0，`/.well-known/agent-card.json` | ✅ 准确。A2A 1.0 milestone 已发布，well-known 路径正确 | [A2A specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md) |
| UCP 2026-04-08 specification family | ✅ 准确。该版本规范存在，Google + Shopify 等共同制定 | [UCP spec overview](http://ucp.dev/2026-04-08/specification/overview/) |
| `/.well-known/ucp` 发布 UCP Profile | ✅ 准确，与官方规范一致 | 同上 |
| UCP `transport = a2a`，endpoint 指向 Agent Card URL | ✅ 准确，官方规范明确 "endpoint for A2A transport refers to the Agent Card URL" | 同上 |
| UCP vendor capability 须用自有 reverse-domain namespace | ✅ 准确，方向正确（但文档示例格式有误，见 P1-3） | 同上 |

结论：Appendix B 的四条外部基线引用没有虚构，架构对 UCP discovery / transport binding 的理解与官方规范吻合。

---

## 3. P1 — 基线化前必须修复

### P1-1 Envelope 的 `protocol` 字段违反 §8.1 自己的命名规则

§8.1 明确：内部可继续用 `kiwi.negotiation/1.0`，但**对外**必须使用 Kiwi 实际控制域名的 reverse-domain namespace。但 §9 的 Negotiation Envelope 是要走 A2A wire 的对外消息，却写着：

```json
"protocol": "kiwi.negotiation/1.0"
```

（`kiwi_a2a_v1.md:701`）

二者矛盾。需要明确 wire 上的 protocol 标识到底用哪个。建议 wire 统一用对外 namespace，`kiwi.negotiation/1.0` 仅作内部模块/代码名。

### P1-2 同一个协议资产有三个标识符，关系未声明

Kiwi Negotiation 目前同时存在三个标识：

- A2A extension URI：`https://<kiwi-domain>/extensions/negotiation/1.0`（line 492）
- UCP vendor capability：`com.<kiwi-domain>.negotiation`（line 603）
- Envelope protocol 字段：`kiwi.negotiation/1.0`（line 701）

建议加一小节明确三者的映射关系与各自出现的位置（Agent Card / UCP Profile / wire envelope）。

### P1-3 UCP capability 命名不符合 UCP 三段式约定

UCP 规范强制 capability 名为 `{reverse-domain}.{service}.{capability}` 三段式（如 `dev.ucp.shopping.checkout`、`com.example.payments.installments`）。文档示例 `com.<kiwi-domain>.negotiation`（line 603）只有两段，应改为类似：

```text
com.<kiwi-domain>.commerce.negotiation
```

### P1-4 "Extension" 一词与 UCP 术语冲突

UCP 中 extension 是精确定义的技术概念——必须带 `extends` 字段声明父 capability。Kiwi Negotiation 作为交易前协商，很可能不是任何现有 UCP capability 的 extension，而是 **vendor root capability**（UCP 允许 root capability，`extends` 缺省）。

§8.1 用了正确的 "UCP Vendor Capability"，但 §30 v0.6 写的是 "vendor negotiation extension advertisement"（line 1706）。建议全文统一为 vendor capability，除非确实要 `extends` 某个 UCP 对象（若 extends，需说明父 capability 是谁）。

### P1-5 标识符模型未定义

全文出现四个会话/交换标识符，职责、生成方、生命周期均未定义：

- `exchange_id`（envelope，line 702）
- `context_ref`（envelope，line 703）
- `negotiation_id`（§10.2，line 760）
- A2A `contextId`（§10.2）

这是协议级文档的核心数据模型，必须补齐一张标识符对照表（谁生成、何时生成、与远端 contextId 的映射点、过期语义）。

### P1-6 幂等与 digest 只有原则没有机制

§26 invariant 11 要求"相同 exchange 重放必须幂等"，§9 提供了 `message_id` 和 `digest` 字段，但全文未回答：

- 谁去重、用哪个 key（message_id？digest？）、去重窗口多久
- 重复消息到达时返回什么
- `digest` 的计算方式：canonicalization 规则、覆盖哪些字段（payload only？整个 envelope 减 digest？）

`digest` 同时承担幂等、审计、重放检测三个职责，其定义缺失会阻塞 Ledger 实现。建议补一节 "Idempotency & Digest"。

### P1-7 状态机存在实际缺口（§11）

- **无 `Offered → Clarifying`**：对报价条款存疑是最高频澄清场景，目前只能从 Countered 进入 Clarifying
- **RFQ 无法进入澄清**：§8.2 说 Clarification 用于"缺失字段"，但 RFQ 缺字段时 `RFQ → Evaluating → ?` 没有通往 Clarifying 的边
- **无 `Countered → Expired`**：counter 所针对的 offer 过期时状态悬置
- **无 Withdraw / Cancel**：Buyer 撤回 RFQ、Merchant 撤回未过期 Offer 均无出口
- **HumanRequired 只能从 Evaluating 进入**：但 §16 Approval Gate 作用于所有外发 action——manual 模式下 Buyer 接受 Offer 同样需要人工审批，`Offered → HumanRequired` 缺边。当前状态机实质是 merchant 视角，buyer 侧审批路径未建模
- 小缺口：`Clarifying → Declined` 缺边（对方拒绝澄清时无终态出口）

---

## 4. P2 — 应当修复的设计/完整性问题

### P2-8 UCP-over-A2A 时 Buyer 如何宣告自己的 profile 未定义

UCP 要求 platform 每个请求都携带 profile URI（HTTP 用 `UCP-Agent` header，MCP 用 `meta` 对象），但这是 HTTP/MCP 特定机制。§7.2 只画了 merchant 侧发现入口；A2A transport 下 buyer profile 走哪个通道（Agent Card？message metadata？）需要定义。

### P2-9 UCP 的 spec/schema URL origin 绑定要求未提及

UCP 强制：`com.<kiwi-domain>.*` namespace 的 capability，其 `spec`/`schema` URL **必须**托管在对应域名下，且 platform 端 MUST 校验该绑定。这直接影响 Kiwi 的域名与协议文档托管基础设施规划，建议在 §7 或 §8.1 补充。

### P2-10 无协议级错误模型

UCP 有完整错误码表（`version_unsupported`、`capabilities_incompatible` 等）。Kiwi Negotiation 对 schema 拒绝、版本不支持、capability 不兼容只定义了本地行为（fail closed），但**远端收到什么**没有定义——Declined？静默断开？建议定义最小 error/reject 消息类型与错误码。

### P2-11 `selected_nonbinding` 无定义

`kiwi_a2a_v1.md:1247` 出现一次后再未出现。它是状态？事件？ledger 标记？与 `AcceptedNonbinding` 的关系不明。

### P2-12 `CounterpartyChannel.discover()` 与 `AgentDiscovery.resolve()` 职责重叠

§5.1 的 channel 接口有 `discover(target)`，§25 又有独立的 `AgentDiscovery` 接口。discovery 归 channel 还是归独立 service，需二选一或说明分工。

### P2-13 消息级签名缺席

Trust 层（§17）只提了 Agent Card 签名验证。UCP 已采用 RFC 9421 HTTP Message Signatures + profile 内 `signing_keys` 实现 permissionless 身份。Negotiation Ledger 强调 content-addressed + auditable，但 envelope 无签名字段——digest 只能检测重放，不能证明"对方真的发了这个 Offer"。即使是非绑定共识，争议取证时这是刚需。建议至少作为 open question 显式登记。

### P2-14 缺反滥用设计

开放网络意味着任何 Agent 都能向 Merchant 发 RFQ。UCP 规范对 profile discovery 专门规定了固定开销预算（fixed-size cache、global rate limit、backoff、异步 discovery）。§31.5 安全测试覆盖了注入/SSRF/重放，但没有 RFQ spam、恶意爬价、资源耗尽这一类。Trust Record 的 `timeout rate` 等字段是好基础，建议在 §17 附近补一段 abuse mitigation。

### P2-15 `disputed terms count` 的仲裁者未定义

`kiwi_a2a_v1.md:1095`：去中心化直连场景下谁认定一次 "dispute"？本地单方面记录易被污染，需说明语义（例如仅记录"我方宣告的争议"还是"双方确认的争议"）。

### P2-16 §2 流程图包含 "Checkout Handoff"（line 140）

与"v1.0 截止于 Accepted Non-binding Agreement"相邻出现，易被读成 v1.0 范围。§19 已标注 "v1.1: Checkout Handoff"，建议 §2 同样标注 `(v1.1+)`。

### P2-17 RFQ fan-out 的需求信号泄露未讨论

§19 一次向 5 个 Merchant 发 RFQ，本身即泄露"这个买家要买 200 台显示器"。§3.4 与 NetworkDisclosurePolicy 管字段级披露，未管 fan-out 策略层面的披露。建议在 §15 或 §19 加一句策略说明（如 fan-out 数量上限、是否匿名化首轮 RFQ）。

---

## 5. P3 — 文字与小问题

- §8.2 六个对象中只有 CounterOffer 没有 JSON 示例（line 662），补齐或统一不给
- Envelope 的 `actor: "buyer"` 枚举值未定义（merchant? system?）
- §25 四个接口引用约 10 个未定义类型（`DiscoveryInput`、`NegotiationIntent`、`NegotiationSnapshot`、`TrustAssessment` 等），架构文档可以接受，但建议加术语/类型附录——顺带可解决 P1-5 的 ID 定义问题
- §3.4 "永远分离"（line 227）与 §15 NetworkDisclosurePolicy "是否可发送联系方式"（line 1020）有措辞张力——实际语义是"默认私有、策略门控披露"，建议 §3.4 列表注明"默认"
- §12 Ledger 的 public transcript 保留/删除策略未提，建议配合 §23 filesystem privacy 整改补一句生命周期说明
- Appendix B 建议给 A2A 1.0.0 与 UCP 各附规范 URL，便于后续对照

---

## 6. 建议处理顺序

1. **先修 P1-1 / P1-2 / P1-3 / P1-4（命名与标识符）**：纯文档修改，工作量小，但影响所有后续 schema 与代码命名。
2. **P1-5 / P1-6 / P1-7（ID 模型、幂等机制、状态机）**：需要真正的设计决策，建议单开 protocol 子文档（如 `kiwi-negotiation-protocol-v1.md`）承载，母文档保持引用。
3. **P2-8 / P2-9 / P2-13**：建议在母文档中以 "Open Questions" 显式登记，避免基线化后被当成已解决。
4. P3 随下一轮编辑顺带处理。

---

## Appendix — 评审中已验证无需修改的点

- 裸 `ACP` 禁令（line 296）：全文 grep 验证合规
- v1.0 产品边界（§27）与安全不变量（§26）、完成定义（§32）三处一致，无矛盾
- 版本路线 §30（v0.4 → v0.7 → v1.0）与 §23 可靠性整改项、Appendix A 继承关系对齐
- Appendix A 引用的四份文档均真实存在于 `docs/`：`agent-runtime-v0.3.md`、`operator-tui-v0.2.md`、`external-agent-adapters-v0.2.md`、`code-review-2026-08-04.md`
- Agent Card 示例（§6.2）的 `supportedInterfaces` / `protocolBinding` / `extendedAgentCard` 字段与 A2A 1.0 格式吻合
