# KNP — Kiwi Negotiation Protocol 1.0（RFC Draft，2026-08-13）

> 状态：**Draft**（P2 社区 RFC，Issue 16 #3）。向 A2A/UCP 社区提交前的提案稿。
> 目标不是立刻拿"官方标准"标签，而是获得外部实现、审阅意见与设计收敛。
> 本稿建立在 P0 实证之上：A2A 1.0 TCK 全绿、官方 SDK 往返、Python 独立实现
> 三向互操作、双语言逐字节 conformance vectors。

## 1. 问题陈述（不是"缺失层"口号）

Agent 之间的**商业磋商**（询价、报价、还价、条件成交、非绑定共识）缺少一个
**商业专用、跨实现、可审计、默认非绑定**的状态与证据规范：

- A2A 提供发现/传输/任务生命周期，不定义商业磋商语义；
- UCP 已提供 A2A negotiation binding，但不定义商业对象（RFQ/Offer/Agreement）、
  绑定语义与成交交接；
- Concordia 关注去中心化磋商的通用框架，不解决"非绑定 Agreement + 审批 +
  外部成交入口"这一商业闭环。

**KNP 主张**：为跨商家、多属性、可审计且默认非绑定的
RFQ → Offer → CounterOffer → Agreement 提供商业专用、可独立实现的状态与证据规范，
并把 Agreement 交接给外部执行系统（KTH）——**不**定义价格策略、不拥有 checkout。

## 2. 与现有方案的逐项比较

| 维度 | KNP/1.0 | UCP A2A negotiation | Concordia（A2A 社区提案 #1725） |
| --- | --- | --- | --- |
| 定位 | 商业专用 RFQ→Agreement（非绑定、可审计） | A2A 通用 negotiation binding | 去中心化磋商通用框架 |
| 商业对象 | `rfq`/`offer`/`counter_offer`/`conditional_offer`/`accept_nonbinding` | 未定义 | 未定义 |
| 绑定性 | `binding_effect: nonbinding` 显式；三副作用恒 false | 未定义商业绑定 | 未定义 |
| 证据 | `accepted_nonbinding_agreement` artifact + 哈希链 transcript | 未定义 agreement artifact | 未定义 |
| 条件成交 | ConditionalOffer（`when.all/any/leaf` + field 词表） | 未定义 | 未定义 |
| 审批 | `human-required` 审批边界 | 未定义 | 未定义 |
| 成交交接 | KTH HandoffCandidate（destination_type 词表单一来源） | 未定义 | 未定义 |
| 独立实现 | 双语言（TS + Python，零依赖）逐字节一致 | 依赖 A2A SDK | 依赖社区实现 |

## 3. 最小扩展范围与明确非目标

**范围**：envelope（9 个核心对象）+ digest（RFC 8785 JCS + SHA-256）+ 状态机
（OPEN/OFFER_OPEN/AWAITING_CLARIFICATION/AGREEMENT_REACHED 等）+ 幂等
（`(sender_identity, message_id)`）+ ConditionalOffer 求值 + A2A 1.0 carrier
mapping + KTH HandoffCandidate。

**非目标**：
- 不做支付/订单/库存预留（三副作用恒 false）；
- 不做价格发现策略（价格由商家商品源决定）；
- 不做 checkout 执行（KTH 只交接，不执行）；
- 不做身份认证协议（复用 A2A/HTTP Message Signature 层）；
- 不定义 UI / 会话协议。

## 4. 线协议 schema、状态机、conformance vectors

- **schema**：`spec/schemas/negotiation/1.0/schema.json`（envelope + 22 `$defs`，
  9 类核心对象；`additionalProperties: false`）。
- **carrier mapping**：`spec/a2a/extensions/negotiation/1.0-carrier-mapping`（A2A 1.0
  SendMessage + KNP DataPart + 0.3-shape 响应 parts + ErrorInfo 错误体）。
- **状态机**：协议正文 §21.2；并发报价按 `offer_id` 隔离（收敛文档 §4）。
- **conformance vectors**：`spec/conformance/knp-1.0-vectors.json`（5 完整 envelope +
  期望 digest；第三方重算 JCS 即自证）。

## 5. 双语言独立实现

- **TS**（生产 runtime）：`harrylabsj/kiwi`——A2A 1.0 双栈 + 官方 TCK 全绿 + SDK 往返。
- **Python**（参考实现，零依赖标准库）：`spec/examples/python/`——JCS/envelope/A2A
  client/merchant/transcript/handoff 全实现；39 unittest 对 TS 生成的 digest
  逐字节一致。
- 三向互操作（`npm run conformance:three-way`）：Independent↔Kiwi↔Independent
  全部 RFQ→Agreement→Handoff 跑通（21 passed）。

## 6. 真实互操作 transcript

- SDK 往返 wire transcript：`docs/reviews/a2a-sdk-conformance-transcript.jsonl`
  （官方 `@a2a-js/sdk` → Kiwi merchant，RFQ→Offer）。
- 三向互操作逐腿 transcript：`npm run conformance:three-way`（含哈希链校验）。
- Python buyer 可校验 transcript：`python3 -m kiwi_ref buyer --url … --jsonl out.jsonl`。

## 7. 安全、审批、non-binding、Handoff 边界

- **non-binding**：`binding_effect: "nonbinding"`；agreement artifact 与
  HandoffCandidate 的 `creates_order`/`authorizes_payment`/`reserves_inventory`
  恒 false（KTH 三副作用不变量）。
- **审批**：`human-required` 审批边界（协议 §22）；外部写默认审批，不执行。
- **Handoff**：KTH 只交接不执行；destination 词表单一来源
  （`src/handoff/destination.ts`，11 值）；URL 类目的地只做安全 HEAD 探测。
- **安全**：JCS content digest 防篡改；幂等防重放；fail-closed（未知扩展/非法
  digest/终态重开一律拒绝）；SSRF 防护；secret 不入 transcript。

## 8. 已知限制与开放问题

- **已知限制**：
  - A2A 1.0 响应 parts 仍为 0.3 形状（`{kind:"data"}`）——解析器不依赖 kind，
    但 wire 不一致；建议在 1.0 规范收敛时统一。
  - ConditionalOffer field 词表当前为白名单（aggregate.* / fulfillment.* /
    service.* / commercial.*）；第三方扩展字段需提案。
  - 并发报价按 offer_id 隔离，但同一 negotiation 多轮并发仍依赖幂等键。
- **开放问题**：
  - streaming / push notifications 是否纳入 P2 范围；
  - Playground 参与者的身份模型（mock / self-operated / external）是否需要
    可验证凭证；
  - KTH destination 是否需要链上锚定（当前为 ledger 哈希链 + 可选外部校验）。

## 复现

```sh
npm run build
npm run conformance:three-way                 # 三向互操作 + vectors
node scripts/conformance/a2a-sdk-roundtrip.mjs # 官方 SDK 往返
cd spec/examples/python && python3 -m unittest discover -s tests -t .  # 39 tests
```
