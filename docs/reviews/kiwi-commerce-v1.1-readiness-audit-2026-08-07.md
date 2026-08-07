# Kiwi Commerce v1.1 就绪度审计

Created: 2026-08-07
方法：把 `docs/kiwi-commerce-v1.1-architecture-draft-rev1.4.1.md` §42 完成定义 21 条
逐条映射到实现代码 + 测试证据，标 ✅（直接实证）/ ⚠️（部分或间接）/ ❌（缺失）。
依据 = kiwi 仓 `main`（89 测试文件，1341 tests 全绿，`npm run verify` 含 lint/
typecheck/build/包冒烟）+ kiwi-catalog 仓 `main`（63 tests，5 skip 为 FastAPI 条件）。

**范围声明**：本审计只评估 v1.1 完成定义的就绪度，**不宣布 v1.1 发布**。
按 rev1.4.1 文档自身约定（"在 v1.1 正式发布前，本文状态始终是 Draft"），
v1.1 的发布决定（含第三方互操作证据、部署验证、产品化打磨）不在本审计内。

## 结论摘要

| 评估 | 数量 | 条目 |
| --- | --- | --- |
| ✅ 直接实证 | 17 | #1-3、#6、#8-10、#12-16、#18-21 |
| ⚠️ 部分或间接 | 4 | #4、#5、#11、#17（见矩阵注记） |
| ❌ 缺失 | 0 | — |

## 逐条矩阵

| # | 完成定义 | 实现 | 测试证据 | 评估 |
| --- | --- | --- | --- | --- |
| 1 | kiwi-catalog 可独立部署，不依赖 shopping-cli 数据库 | 独立 Python FastAPI 项目（`<WORKSPACE>/kiwi-catalog`：独立 schema、shadow tables、migration v8、Docker/systemd 部署物）；`catalog_agents` 表对 merchants 仅弱引用 | `test_kiwi_catalog_service.py`（独立库端到端）、`test_fastapi_dualstack.py`、`test_shadow_tables.py`（缺影子行不崩） | ✅ |
| 2 | Kiwi AgentDiscovery 可使用 KiwiCatalogSource | `src/discovery/catalog-source/kiwi-source.ts`（/v1/agents 消费端）+ `CatalogSource` 接口化（`resolve.ts` resolveViaCatalog 可互换） | `tests/kiwi-catalog-source.test.ts`（searchRecords/searchCandidates/getCandidate + resolveViaCatalog 集成 2 例） | ✅ |
| 3 | Direct well-known discovery 在没有 kiwi-catalog 时仍可工作 | `resolve()` 的 well-known 路径零改动（catalog 是可选 deps）；既有 1235→1341 tests 全绿为回归证据 | `tests/discovery-catalog-source.test.ts`（resolveViaCatalog 可选性）、`tests/discovery-resolve.test.ts`（直连路径） | ✅ |
| 4 | shopping-cli 不再承担 network Agent Catalog authority | 服务边界证据：Agent Catalog 已整体迁出为独立 kiwi-catalog 项目（`/v1/agents` 三态域 + 独立 schema）；TS 侧 `ShoppingCliCatalogSource` 降级为 legacy 消费端 | `test_merchant_single_agent.py`（catalog 数据层自洽）、kiwi-catalog 独立库测试 | ⚠️（仓库/服务边界证据，无单一"authority 转移"功能测试） |
| 5 | shopping-cli 可作为 Merchant CommerceDataSource | `src/commerce/data-source.ts` 数据侧边界（≠ CommerceClient 通信侧 ≠ CounterpartyChannel）+ `local-db-source.ts`/`erp-source.ts` 两实现 + composite 冲突 fail-closed | `tests/commerce-data-source.test.ts`（15 例） | ⚠️（抽象+两实现就位；shopping-cli 特定 adapter 未单独建——HTTP 端点可经 ErpCommerceDataSource 泛化接入） |
| 6 | shopping-cli 至少支持一种本地数据库源 | `LocalDatabaseCommerceDataSource`（node:sqlite，LOCAL_AUTHORITATIVE） | `tests/commerce-data-source.test.ts`（本地库读写/权威标注/listing） | ✅ |
| 7 | shopping-cli 至少支持一种 ERP / external business data adapter | `ErpCommerceDataSource`（HTTP adapter，UPSTREAM_PROXY，超时/HTTP/结构失败 fail-closed） | `tests/commerce-data-source.test.ts`（ERP 成功/404/网络/超时/结构错误） | ✅ |
| 8 | Merchant private data 不进入 kiwi-catalog | TS 契约 `contracts/kiwi-catalog/1.0/agent-record.schema.json` additionalProperties:false（私有字段在 schema 层拒绝）；Python register 只读取白名单字段（display_name/hosting_mode/handoff/capabilities/skills），未识别字段不落库 | `tests/kiwi-catalog-source.test.ts`（私有字段 contract_violation）、`test_kiwi_catalog_v1_api.py`（record 无私有字段） | ✅（注：新 API register-input 的 schema 硬拒未落盘，依赖白名单读取实现） |
| 9 | Agreement 可生成 HandoffCandidate | `handoff_agreement` 工具（selected_nonbinding 任务 → createHandoffCandidate）+ `src/handoff/candidate.ts` | `tests/handoff-candidate.test.ts`（构造即校验）、`tests/handoff-e2e.test.ts`（全链路） | ✅ |
| 10 | HandoffCandidate 绑定 agreement/terms digest/destination/identity | candidate 构造即校验：agreement_id/negotiation_id、terms_digest 重算比对、destination 词表、buyer/merchant identity ref | `tests/handoff-candidate.test.ts`（digest 一致性/篡改拒绝/身份 ref） | ✅ |
| 11 | Handoff 支持至少 external URL、PO/quote/contact 中三类目的地 | `DESTINATION_TYPES` 11 值（external_checkout_url/platform_deep_link URL 类 + quote/PO/contact 文档类）；执行层对非 URL 类不做 URL 探测 | `tests/handoff-e2e.test.ts`（**E2E 实证 2 类**：external_checkout_url + quote_document）、`tests/handoff-stale-revalidation.test.ts`（external URL 路径） | ⚠️（域模型覆盖全部 11 类；E2E 实证 2 类，PO/contact 无 E2E 测试） |
| 12 | Handoff 不创建订单 | executeHandoff 无订单路径；TransactionHandoff.creates_order 恒 false | `tests/handoff-stale-revalidation.test.ts`（事件序列无 order/payment/inventory）、`tests/handoff-e2e.test.ts`（断言） | ✅ |
| 13 | Handoff 不授权支付 | 同上（authorizes_payment 恒 false） | 同上 | ✅ |
| 14 | Handoff 不预留库存 | 同上（reserves_inventory 恒 false） | 同上 | ✅ |
| 15 | 目的 URL 有 HTTPS / redirect / phishing 防护 | `src/handoff/url-safety.ts`（HTTPS 默认/unsafe scheme 拒绝/userinfo 拒绝/expectedHost+allowlist 绑定/重定向每跳重验/maxRedirects）+ executeHandoff 集成（仅 URL 类目的地） | `tests/handoff-url-safety.test.ts`（10 例全矩阵） | ✅ |
| 16 | stale Agreement 或 destination 可使 HandoffCandidate 失效 | executeHandoff §10 revalidation：agreement 消失/身份变化/terms_digest 不匹配/expiry/目的地无效 → stale/expired 事件 + 不执行 | `tests/handoff-stale-revalidation.test.ts`（4 例） | ✅ |
| 17 | 用户能看到 Handoff 目标和已谈妥摘要 | `display_summary`（merchant + summary）+ kernel `handoffSummary` getter（/handoff 命令，Ledger 投影）+ 工具交付文本 | `tests/handoff-e2e.test.ts`（交付文本断言）；kernel getter 无单测 | ⚠️（数据面与工具文本实证；TUI /handoff 交互未真机验证） |
| 18 | Ledger 可审计 Handoff created/delivered/opened/expired | `HandoffEventStore`（复用 LedgerStore 引擎：append-only/hash-linked/verifyChain/禁词）+ 12 个 handoff event kinds + **digest 覆盖修复**（篡改 terms_digest/evidence 可检出） | `tests/handoff-ledger.test.ts`（事件过滤/evidence 落链/篡改检出/事件重建/禁词） | ✅ |
| 19 | 不把 external URL opened 误报成 order/payment success | LAUNCHED 不证明页面加载、OPENED_CONFIRMED 需可归属证据（四类白名单，无证据永不确认）；metrics `reported_external_conversion` 恒 null | `tests/handoff-delivery.test.ts`（证据门全矩阵）、`tests/handoff-metrics.test.ts`（external conversion null） | ✅ |
| 20 | 至少一个端到端场景达到 Agreement → Handoff → external checkout/ERP | `tests/handoff-e2e.test.ts`：negotiate_buyer_task → selected_nonbinding → handoff_agreement（write gate）→ executeHandoff → delivered → launch → 证据门 | 2 个 E2E 用例（external checkout URL + quote_document 目的地） | ✅ |
| 21 | Negotiation-to-Handoff Rate 可观测 | `src/handoff/metrics.ts` 纯函数（agreement_to_handoff/launch/opened_confirmed/negotiation_to_handoff/time_to_handoff）+ `kiwi metrics --dir` 命令 | `tests/handoff-metrics.test.ts`（空/全 1/0.5 率/时长/external null） | ✅ |

## 实现中顺带修复的地基问题（审计注记）

1. **Ledger digest 覆盖缺口**：`eventContentAddressable` 原不包含 handoff 溯源/证据
   字段，篡改 `terms_digest`/`evidence` 无法被 verifyChain 检出——已纳入 digest
   输入（#18 的直接实证基础）。
2. **legacy fallback GET-by-id 位置参数 bug**（FastAPI 栈正常、fallback 栈 404）已修。
3. **URL 安全只对 URL 承载类目的地生效**（quote/PO/contact 的 opaque ref 不做 URL 探测，
   符合 KTH §7 类型语义）。

## 声明

- v1.1 完成定义 21 条：**17 条直接实证、4 条部分或间接、0 条缺失**。
- 本审计**不宣布 v1.1 发布**。v1.1 仍为 Draft（rev1.4.1 §0）；发布前还需：
  v1.1 就绪度审计随发布决策复核、kiwi-catalog Python 服务部署冒烟（Docker/
  systemd）、#11 的 PO/contact 目的地 E2E 补齐、#17 的 TUI 真机交互验证、
  第三方互操作证据（文档明确禁止宣称，维持）。
