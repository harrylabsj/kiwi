# kiwi-buyer-mcp 薄 Facade（v0.1）

状态：PILOT DRAFT（Phase 1 交付）
文档版本：v0.1 · 发布日期：2026-08-15
适用范围：`kiwi-buyer-mcp`（Northbound）、四份 Northbound 契约、
持久 Task/Approval 存储、五层授权、Hermes 接入面

## 1. 目标

战略基线 v2.5 的北向面：让任何已有 AI Agent（Hermes/Kimi/Codex/OpenClaw/企业
Agent）在不获得 Kiwi 专属 UI、不迁移用户记忆、不更换模型的情况下，安全获得
"发现商家—询价—多商家比较—还价—形成非绑定协议—交易 handoff"的能力。

设计原则（§5.1）：
- Host Agent owns conversation.
- UCP owns standard commerce primitives.
- Kiwi owns cross-merchant sourcing and commercial negotiation.

## 2. 四份冻结契约（contracts/，schema 单一来源）

| 契约 | 路径 | 版本 | 核心内容 |
|---|---|---|---|
| CommerceIntent | `contracts/commerce-intent/1.0/schema.json` | 1.0 | intent_type(purchase/procurement/inquiry) + items + constraints + preferences + context_projection（最小披露） |
| DelegationPolicy | `contracts/delegation-policy/1.0/schema.json` | 1.0 | 7 类动作 → AUTO/ASK/NEVER + 硬限制；payment 恒 never |
| EffectiveAuthorization | `contracts/effective-authorization/1.0/schema.json` | 1.0 | 五层交集 deny 优先，granted ⇔ 全部 allowed |
| PersistentTask | `contracts/persistent-task/1.0/schema.json` | 1.0 | task_id/candidate_id/approval_id/agreement_id + idempotency_key + expires_at + 部分失败 + 恢复 |

运行时加载与校验：`src/contracts/northbound-schema.ts`（ajv 2020 + ajv-formats，
同 negotiation-schema 模式）；向量测试 `scripts/verify-contract-vectors.mjs` +
`tests/northbound-schema.test.ts`。

## 3. 7 个高层 Sourcing Tools（§6.1 词表）

不暴露 KNP 底层消息、不复制 UCP 的 Catalog/Checkout primitives。每个写工具绑定
idempotency_key 并返回稳定 task_id / candidate_id / approval_id / agreement_id。

| Tool | 用途 | 写/读 |
|---|---|---|
| `kiwi_search` | 发现候选供应商（只读；Merchant routing） | 读 |
| `kiwi_request_quotes` | 发起询价（幂等；返回稳定 task_id；fan-out） | 写 |
| `kiwi_get_task` | 任务状态/报价/部分失败/待审批/过期（统一 resume 面） | 读 |
| `kiwi_negotiate` | 委托边界内推进磋商（CounterOffer/Clarification） | 写 |
| `kiwi_accept_agreement` | 接受非绑定协议（要求 approval_id + candidate_id） | 写 |
| `kiwi_get_agreement` | 读取协议 + digest + 审计摘要 | 读 |
| `kiwi_handoff` | Agreement → UCP Checkout / merchant endpoint | 写 |

## 4. 架构（单核心多包装，§6.3 / Appendix A）

```
src/buyer-core/            ← 单核心（所有商业判断）
├── service.ts               KiwiBuyerService（状态机 + 五层授权 + 幂等）
├── store.ts                 TaskApprovalStore（node:sqlite）
├── errors.ts                McpError 类型化错误
├── merchant-index.ts        KiwiCatalogMerchantIndex / MarketplaceMerchantIndex
├── quote-fetcher.ts         MarketplaceQuoteFetcher（真实 RFQ fan-out）
├── negotiator.ts            MarketplaceNegotiator（真实磋商）
└── build-service.ts         buildBuyerService（包装注入统一入口）

src/mcp/   ← MCP adapter（types/tools/server/cli；薄）
src/http/  ← HTTP adapter（server/cli；薄，同一核心）
```

状态权威：TaskApprovalStore（SQLite）是 task/pending/approval 的唯一权威；
MCP server / plugin / Host UI 只投影状态，不保存第二套状态机（§6.2）。

执行 seam（Phase 2 接线真实 merchant 网络）：`MerchantIndex` / `QuoteFetcher` /
`Negotiator` 为可注入接口；v0.1 CLI 默认不接线，任务保持 in_progress + resumable。

## 5. 五层授权（§5.5 deny 优先）

`evaluateAuthorization` 构造 EffectiveAuthorization 记录并强制过冻结 schema：
- 第 4 层 DelegationPolicy：never → deny；ask → 必须存在已批准且动作一致的
  持久 approval（否则 `approval_required`，携带持久 approval_id）；auto → allow。
- 第 5 层 MerchantHardPolicy：硬限制/期限过期 → deny。
- deny-wins：任一独立层 denied ⇒ effective_decision=denied（schema 强制）。

AcceptNonbinding / handoff 的 approval 必须动作匹配（accept 审批不能用于
handoff）；`requestApproval` / `approveApproval` / `rejectApproval` 为宿主适配面
（非 7 个 MCP 工具）。

## 6. 安全与 fail-closed

- initialize 版本协商：未知 protocolVersion 拒绝（§6.10 兼容矩阵 fail closed）。
- tools/* 在 initialized 前返回 SERVER_NOT_INITIALIZED。
- 未知工具 / 未知方法 / 非法 JSON 返回对应 JSON-RPC 错误。
- CommerceIntent 不合法 → contract_violation，写库前拒绝。
- Host-context isolation：只存投影的 intent，无 Principal Memory / 对话历史 /
  宿主工具泄漏（§5.4）。

## 7. 验收

`npm run verify` 全绿（lint + typecheck + build + vitest + verify:contracts +
verify:vectors + verify:package + verify:python-ref）。关键测试：
`tests/northbound-schema.test.ts`、`tests/mcp-facade.test.ts`（20 例：流程、
幂等、deny-wins、host isolation、UCP/KNP boundary、协议面、重启持久化）。

冒烟：`printf '<jsonrpc-lines>' | kiwi mcp serve --db <db> --principal <p>`。

## 8. Hermes Host 接入状态（Phase 2 轨）

已交付：
- `integrations/hosts/hermes/SKILL.md`（kiwi-buyer skill）+ `mcp-servers.example.yaml`；
  本机 `~/.hermes/config.yaml` 已接线 `mcp_servers.kiwi-buyer-mcp`
  （`--marketplace-url :8765` + `--buyer-bootstrap-token` + `--catalog-url :8000`）。
- Hermes 自动发现 7 个工具（`hermes mcp test` ✓ Connected, 7 tools）；真实对话
  调用 kiwi_search / kiwi_request_quotes / kiwi_get_task（端到端验证，如实报告）。
- 真实供应侧（Phase 2 Supply 轨）：`scripts/pilot/seed-merchants.sh` 自建 5 家
  真实数据商家（办公/IT 48 商品，含 5 家共享大宗商品差异化定价）；
  `run-marketplace.sh` 启动 marketplace + 商家 agent daemon；
  `MarketplaceQuoteFetcher`（POST /conversations → 轮询真实回复 → provenance+
  reply_text）；`MarketplaceMerchantIndex`（`/search/products?query=` 商品 FTS
  路由 + CJK 相关度过滤 → 各商家 matching_skus，RFQ 用商家自有 SKU）；
  `register-catalog.sh` 注册商家进 kiwi-catalog（admin + merchant_id）。
- 证据门：`scripts/pilot/evidence-gate.mjs` 批量真实 RFQ + 可审计报告。
  2026-08-16 首轮 **26/26 Qualified RFQ**，5 家比价 DOCK-6IN1 真实报价
  189/199/209/185/195 CNY（报告在 `.kiwi/pilot/evidence/`）。

已扩展（Phase 3 / 后续交付）：
- **单核心多包装**：`src/mcp/build-service.ts` 共享 `buildBuyerService`；
  `kiwi buyer-api serve`（`src/http/`）暴露同一 Buyer Core 的 HTTP 包装，
  与 MCP 同一语义不变量（schema/授权门/幂等/错误分类）。真实冒烟：HTTP
  POST /tasks 拿到真实商家报价。
- **Merchant Independence**：`scripts/pilot/merchant-independence.sh` 关闭
  Hermes/推理 harness 后，marketplace + resident daemon 独立应答真实 RFQ
  （§7.4 Standalone-first 验证通过）。
- **兼容性工件**：`compatibility/{ucp-knp-boundary,host-harness-matrix}.md`
  （§6.10 语义不变量 + UCP/KNP 边界）。

待接线（Phase 3 主体 / Phase 4）：
- Merchant Ops API（`kiwi.merchant.*`）+ 三 Plane 拆分工程；Merchant UCP-native
  （UCP Profile / Catalog adapter 发布）。
- Buyer Core 物理抽离为独立包（`packages/buyer-core`，Appendix A）——当前
  `src/mcp/` + `src/http/` 已是逻辑单核心多包装，物理拆包待证据门后。
- ≥20 Qualified RFQ 的 30–45 天持续证据；Phase 4 按真实采用扩张 Host。
