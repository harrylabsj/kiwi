# Changelog

## v1.0.0 — 2026-08-07

**A2A v1.0 正式发布。** 基线 §41 完成定义 27/27 经就绪度审计（`docs/kiwi-a2a-v1.0-readiness-audit-2026-08-06.md`）逐条实证满足。

### 协议与发布

- §41 #6：公开稳定 namespace `com.harrylabsj.kiwi.shopping.negotiation`，spec/schema 托管于
  `https://kiwi.harrylabsj.com`（Cloudflare Pages，公开仓库 `harrylabsj/kiwi-spec`）。
- §41 #7：九类核心 Negotiation Objects 冻结为 JSON Schema（`contracts/negotiation/1.0/schema.json`），
  与领域实现交叉一致性对齐（digest 必填、offer-like items 要求 unit_price、withdraw/decline scope 约束等）。
- 协议文档状态 Draft → Normative（Released）；基线 §41 加盖宣布戳。

### 实现（v0.4–v1.1 累计）

- **v0.4 谈判基础**：KNP 领域模型、条件求值器、Ledger、幂等、Legacy Adapter。
- **v0.5 原生 A2A**：Agent Card、A2A client/server、Task 生命周期与恢复、Channel 抽象、鉴权。
- **v0.6 UCP interop**：profile 模型/resolver、capability intersection、well-known 服务、UCP-Agent、双入口发现。
- **v0.7 开放网络**：trust records、fan-out 隐私 + 多商家 RFQ、服务端限流、interop E2E。
- **v1.1 交易 handoff**：agreement→checkout 桥、UCP checkout channel、operator 授权、只读 order records、ACP-Commerce 接缝。
- **发现层**：ShoppingCliCatalogSource（Agent Catalog 作为发现源）、UCP cart capability client。

### 验证

- 1236 tests（75 文件）全绿；§41 #24 network partition 端到端测试补入。
- `npm run verify`（lint/typecheck/build/test/package）通过。

### 行为边界（§41 #25/#26/#27）

- KNP/1.0 在非绑定商业协议处终止：不创建订单、不执行支付、不锁库存
  （agreement 三副作用 flag 恒为 `false`，schema 与领域双重强制）。
