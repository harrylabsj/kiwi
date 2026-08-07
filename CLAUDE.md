# CLAUDE.md — Kiwi

Kiwi A2A Agent Commerce Runtime：Buyer/Merchant Agent 跨运行时直接发现、沟通、
询价、报价、还价、澄清，形成非绑定商业共识（KNP/1.0），并经 Transaction
Handoff（KTH/0.1）安全交给外部成交入口。

- **v1.0 已发布**（27/27 完成定义，2026-08-07）。
- **v1.1 为 Draft**（Handoff + 产品拆分，21/21 完成定义已直接实证——见
  `docs/reviews/kiwi-commerce-v1.1-readiness-audit-2026-08-07.md`；不宣布发布，
  不宣称第三方互操作证据）。

## 文档地图

- **`docs/CURRENT-DOCS.md` 是身份入口**：file mtime 不是版本权威；`status` /
  `doc_revision` / 产品版本 / git commit-tag / 该清单共同决定文档身份。
- 已发布权威：`docs/kiwi-a2a-architecture-baseline.md`（rev1.2）、
  `docs/protocol/kiwi-negotiation-protocol-1.0.md`。
- v1.1 当前草稿：`docs/kiwi-commerce-v1.1-architecture-draft-rev1.4.1.md`（§42 =
  完成定义 21 条）、`docs/products/*`、`docs/protocol/kiwi-transaction-handoff-0.1-rev0.3.md`、
  `docs/testing/kiwi-commerce-v1.1-test-plan-v0.2.md`。
- 评审/审计文档统一在 `docs/reviews/`；路径引用按仓库根相对（如
  `docs/reviews/…`）。

## 常用命令

```sh
npm test              # vitest run（全离线）
npm run typecheck     # tsc --noEmit
npm run build         # tsc -p tsconfig.build.json
npm run verify        # lint + typecheck + build + test + 包冒烟（改动后必跑）
npm run lint          # eslint . --max-warnings=0
```

## 代码布局（src/）

- `a2a/` — A2A 协议层（client/server/task/negotiate.ts 高层磋商编排）
- `negotiation/` — KNP 域模型（domain/ 对象、ledger/ 事件链、idempotency/、
  recovery/、condition/、state/、jcs.ts、action-candidate.ts）
- `handoff/` — **v1.1 KTH**：destination.ts（词表单一来源）、candidate.ts、
  lifecycle.ts、ledger.ts、delivery.ts、transaction.ts、url-safety.ts、
  idempotency.ts、metrics.ts + v1.0 WP1 工件（package/channel/authorization/
  completion，保留不重命名）
- `discovery/` — AgentDiscovery（resolve.ts）、agent-card/、ucp/、
  catalog-source/（ShoppingCliCatalogSource legacy + KiwiCatalogSource）
- `counterparty/` — Channel 抽象（a2a-direct / shopping-cli-hosted / platform-api）
- `commerce/` — **数据侧边界 CommerceDataSource**（data-source.ts + local-db/
  erp/shopping-cli 三实现）；≠ `CommerceClient`（磋商轮询通信侧）≠
  `CounterpartyChannel`（A2A 通道）
- `agent/` — AgentKernel、buyer/（task-store、buyer-tools）、merchant/、
  memory/、write-gate.ts（routeWriteCandidate 审批门）
- `contracts/` — ajv schema（negotiation/1.0、kiwi-catalog/1.0、
  candidate-agent-dto-1.0）

## v1.1 必须遵守的设计决策（实现/评审时）

- **KTH 术语双轨**：`HandoffCandidate`（不可变 + Ledger 事件投影生命周期）
  与 `HandoffPackage`/`HandoffSession`（v1.0 WP1 UCP checkout 层）并存，
  不重命名、不合并。
- **三副作用不变量**：HandoffCandidate/TransactionHandoff 的
  `creates_order`/`authorizes_payment`/`reserves_inventory` 恒为 false。
- **OPENED_CONFIRMED 证据门**：只有四类可归属证据（local_callback 绑定
  handoff_id / merchant_callback / platform_callback / verified_return_uri）
  可触发；`LAUNCHED` 不证明页面加载；无证据永不确认。
- **destination_type 词表单一来源**：`src/handoff/destination.ts`；任何地方
  （catalog 搜索、shopping-cli 元数据）不得发明 `supports_*` 平行词表。
- **Ledger digest 覆盖全部内容字段**：`eventContentAddressable` 必须包含新增
  事件字段（JCS 跳 undefined 向后兼容）——否则篡改不可检出（历史教训）。
- **URL 安全只对 URL 承载类目的地生效**（external_checkout_url /
  platform_deep_link）；quote/PO/contact 的 opaque ref 不做 URL 探测。
- **幂等键分离**：handoff `(source_candidate_id, source_candidate_digest)`
  保留 ≥7 天，不混用 negotiation 的 `(sender_identity, message_id)` 24h floor。
- **CatalogSource 接口**：ShoppingCliCatalogSource（legacy /v1/agent-catalog）
  与 KiwiCatalogSource（/v1/agents 三态域）可互换；resolveViaCatalog 一律
  fresh verify，候选元数据不被直接信任。
- **跨仓契约**：`contracts/kiwi-catalog/1.0/agent-record.schema.json` 与
  kiwi-catalog 仓（`<WORKSPACE>/kiwi-catalog`）的 `/v1/agents` 响应逐字节一致；
  词表契约测试 `tests/kiwi-catalog-source.test.ts` 断言 schema enum ===
  DESTINATION_TYPES。

## 代码约定

- ESM：所有内部 import 带 `.js` 后缀；Node >= 22。
- 零新运行时依赖（当前仅 4 个）；SQLite 用 `node:sqlite`，HTTP 用 `node:http`
  或裸 fetch；目录 0700 / 文件 0600。
- fail-closed：任何校验/网络/状态异常抛类型化错误（`*.ts` 内
  `XxxError` + code），不静默容错、不自动降级。
- 新事件种类必须进 `LEDGER_EVENT_KINDS` + `eventContentAddressable`；
  新公开仓库函数/Protocol 方法须进 kiwi-catalog 的 `_CATALOG_MAPPING` 测试。
- 文件头 Apache 2.0 license header；中文 JSDoc 说明模块语义。

## 测试

- 全部离线（node:sqlite + 临时 http server）；`tests/helpers.ts` 的
  `startTestA2aStack`（生产 merchant handler + productSource 桩 + catalog
  stub + capture）是集成/E2E 测试的标准基座。
- v1.1 测试文件：`tests/kiwi-catalog-source`、`commerce-data-source`、
  `handoff-{candidate,lifecycle,ledger,delivery,url-safety,idempotency,
  stale-revalidation,metrics,e2e,tui}`。
