# DeepSeek Harness Adapter（受限 ReasoningBackend，P0 第三轨）

战略 v2.5 §6.9 / §十一 Phase 2 的 DeepSeek Harness contract gate。当前所指
`HenryZ838978/deepseek-harness` 是第三方 protocol-aware adapter（非 DeepSeek
官方产品），提供 Python library / CLI / MCP / Skill 四类包装，强调"单一 protocol
contract、多 wrapper 分发"。

## Kiwi 的角色边界（§3.3 / §6.9）

Kiwi ↔ DeepSeek Harness 只验证 **contract / tool-loop 兼容**：

- Harness 只作为受限 ReasoningBackend：根据角色裁剪后的 snapshot 生成
  **不可信 DecisionCandidate**（建议报价 / CounterOffer / Clarification）；
- **不持有 Commerce token、不拥有 Buyer/商家状态机、无任何最终写入权**；
- 所有候选必须回到 Kiwi 的 DelegationPolicy、Persistent Approval 与 KNP state
  machine 才能形成最终写入（§5.5 / §7.6）。

## 验收门（Phase 2）

`node integrations/harnesses/deepseek-harness/validate-contract-cases.mjs`

- 用同一 RFQ/Negotiation corpus（contract-cases.jsonl，复用试点真实意图）跑
  20+ 条可重复 contract cases；
- 校验 DecisionCandidate 满足冻结 decision 契约 + 动作在委托边界内；
- 断言 **0 次越权 Commerce 写入**（后端无写路径，验证器追踪零写）；
- 缺省 mock（确定性候选，验证契约不依赖具体模型）；设 `DEEPSEEK_API_KEY`
  时切换到真实 deepseek-harness 客户端（协议安全调用，C1–C10 规则）。

## 与 Hermes 轨的关系

Hermes = 完整 Host Agent（Host→Kiwi Buyer，产品入口）；DeepSeek Harness =
protocol-aware harness（Kiwi↔Harness，contract/model 独立性验证面）。二者共享
CommerceIntent / DelegationPolicy / Persistent Task / KNP/UCP 边界，不同点只在
宿主体验、推理实现与包装形式（§6.9）。

## 运行时插件（2026-08-17）

本 harness 的 contract gate 与 `src/merchant/decision-backend.ts`（`MerchantDecisionBackend`
接口 + `DeepSeekDecisionBackend` raw fetch 实现 / `MockDecisionBackend`）是**受限
ReasoningBackend 的验证/可复用面**——它镜像本文件 `realCandidate`/`mockCandidate` 的
schema 驱动 prompt、`extractJson`、role bounds。

**注意（2026-08-17 设计修正）**：**kiwi merchant 的定价是确定性的，不依赖 LLM**。
生产 merchant handler（`src/a2a/server/merchant-handler.ts`）**不咨询** decision
backend——买家还价在 `[floor, list]` 内确定性响应（floor / list 均来自可配置的
`merchant_policy`），促销（批量门槛/折扣）也是配置项。本 harness / decision-backend
模块保留为 contract-gate 验证面（`npm run verify:harness`），不作为 merchant 的
定价权威。两处 prompt 仍须保持同步（本文件只读验证面 ↔ `src/merchant/decision-backend.ts`）。
