# Kiwi 产品战略升级—代码实现对齐

日期：2026-08-17  
适用范围：`kiwi` / `kiwi-catalog` / `shopping-cli` / Buyer Kit / Merchant Runtime  
状态：当前实现对齐页；战略方向已批准，执行仍受证据门约束。

## 1. 当前结论

v2.5 的产品方向已经落到代码骨架：

- Buyer 是 Host-native 的 Sourcing & Negotiation Kit，不再争夺通用 Agent 入口；
- Merchant 是 Standalone-first 的企业运行时，不能依赖 Host、Harness 或 LLM 才能接收 RFQ、执行策略、进入人工审核和恢复任务；
- UCP 负责 Catalog / Cart / Checkout / Order 等标准商业原语；KNP 只负责 Inquiry、RFQ、Offer、CounterOffer、ConditionalOffer、Agreement 与 handoff；
- Hermes 是首个真实 Host reference；DeepSeek Harness 是受限 ReasoningBackend / contract gate；OpenClaw、Kimi、Codex、WorkBuddy 暂不扩张。

## 2. 战略决定与实现映射

### 2.1 Buyer Host-native

代码入口：

```text
src/buyer-core/       # intent / policy / routing / RFQ / negotiation / agreement / handoff
src/mcp/              # MCP adapter
src/http/              # HTTP adapter
integrations/hosts/hermes/
```

当前状态：已形成单核心、多包装；MCP/HTTP/Host 适配层不保存第二套商业状态机。

### 2.2 Persistent Task / Approval / EffectiveAuthorization

`src/buyer-core/store.ts` 持久化 task、approval、candidate 和 agreement；写操作使用幂等键，授权采用五层交集、deny 优先，accept/handoff 绑定持久 `approval_id`。对应语义不变量见 `compatibility/host-harness-matrix.md` 与 `compatibility/ucp-knp-boundary.md`。

### 2.3 Hermes + DeepSeek Harness 双突破口

- Hermes：通过 `integrations/hosts/hermes/` 使用 MCP + Skill 连接 Buyer Core，是当前用户入口。
- DeepSeek Harness：通过 `integrations/harnesses/deepseek-harness/` 和 `src/merchant/decision-backend.ts` 验证受限 DecisionCandidate contract；不持有 Commerce token，不拥有最终写入权。
- 当前 contract gate：24/24 cases；越权 Commerce 写入为 0。Merchant 定价生产路径已改为确定性 `merchant_policy`，不咨询 LLM。

### 2.4 Merchant Standalone-first / 三 Plane

Merchant 的 authoritative state 在 shopping-cli / Merchant Core；Commerce Plane 保存商品、库存、价格和交付 truth；Intelligence & Ops 只投影状态、提交候选或审批输入。`scripts/pilot/merchant-independence.sh` 和 `scripts/pilot/merchant-three-plane-check.sh` 是当前验证入口。

当前实现已覆盖确定性报价、底价边界、`human_required`、Merchant Ops 与恢复路径；下一步需要把受控运行的结果保存成可复核证据，而不只保留脚本和单元测试。

### 2.5 UCP-first / KNP boundary

`compatibility/ucp-knp-boundary.md` 与 `tests/mcp-facade.test.ts` 固定以下不变量：

- MCP 只暴露高层 sourcing 工具，不暴露 KNP 底层消息；
- Agreement 的 `creates_order`、`authorizes_payment`、`reserves_inventory` 恒为 `false`；
- payment 的 DelegationPolicy 恒为 `never`；
- 商品 truth 留在 Merchant/UCP endpoint，Kiwi 只保存候选引用、provenance 和回复；
- handoff 只交接，不声称完成外部交易。

## 3. 当前现实证据

- Kiwi 当前 HEAD：`4fd0207b7f9f45115fab86f73bd18bcf8424fe98`。
- 版本：Kiwi `0.7.15`；kiwi-catalog `0.2.3`；shopping-cli `3.2.1`。
- 当前 Kiwi 本地门禁：141 个测试文件、1998 个测试通过；官方 A2A SDK 往返通过；三向互操作 21/21 通过。
- 本地 pilot：26/26 Qualified RFQ、5 家 seeded merchants、97.2% merchant response、2072ms median latency；证据文件为 `.kiwi/pilot/evidence/evidence-2026-08-16-26rfq.json`。

上述 pilot 证明技术闭环，不证明第三方采用。当前报告使用本地 `127.0.0.1:8765` marketplace，且 `sourcing-index.json` 中 listing freshness 已为 `stale`、verification 为 `discovered`，外部试点前必须刷新。

当前 handoff 报告以 `purchase_order_draft` 为主；下一阶段必须补真实 UCP Checkout、PO/CRM 或 Merchant transaction endpoint 的权威回执，并关联同一 `agreement_id`。

## 4. 当前下一步

### Gate 0：候选发布

1. 同步 `CURRENT-DOCS.md`、发布文档和三仓版本身份。
2. 运行固定 SHA 组合门禁。
3. 运行 protected release dry-run；正式 publish 前确认 `kiwi-release`、npm/PyPI Trusted Publisher 和 `verify-registry` 条件。

### Gate 1：真实 B2B Pilot

1. 冻结标准化办公/IT 小批量采购 ICP。
2. 用 Hermes + `kiwi-buyer-mcp` 接入 3–5 家真实外部 Merchant。
3. 持续 30–45 天，至少 20 个 Qualified RFQ。
4. 记录 TTFRFQ、response rate、partial failure、Verified Agreement-to-Handoff Rate、协议价值和 7/30 天复用。

### Gate 2：Merchant Independence / Harness

1. 关闭 Hermes 与 DeepSeek Harness，验证 Merchant Core 仍能报价、排队、恢复和升级人工审核。
2. 保存 below-floor → `human_required` → Merchant Ops resolve 的完整报告。
3. 保持 DeepSeek Harness 只生成不可信候选，越权 Commerce 写入为 0。

## 5. 证据门之后才做

- 根据真实 Pilot 摩擦决定 Buyer Core 的物理拆包边界；
- 完善 Merchant UCP Profile、Catalog adapter、真实 handoff 和 Merchant Ops API；
- 先做 ERP/PIM/CSV/自建 API 等真实需要的 Connector；
- 按真实用户来源选择一个下一个 Host；
- 评估 Kiwi Merchant OSS / Cloud / Enterprise 的付费意愿。

## 6. 明确暂缓

- OpenClaw / Kimi / Codex / WorkBuddy 的产品化接入；
- 在证据门之前进行大规模 Buyer Core 重构；
- MCP Apps、共享 Bundle、Shopify/WooCommerce 等非试点必需扩展；
- 把本地三向互操作、本地 seeded merchants 或本地 PO draft 宣称为第三方采用或真实交易成功。
