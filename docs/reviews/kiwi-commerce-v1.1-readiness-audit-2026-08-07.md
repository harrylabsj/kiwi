# Kiwi Commerce v1.1 就绪度审计

Created: 2026-08-07
Updated: 2026-08-07（两轮 code-review 修复后同步：1349→1361 tests；实现引用与
测试基线更新到 `3fb38b5` fix(review) 提交后的代码状态）
Updated: 2026-08-07（发布复核：架构调整 `3bfa46b` 后 kiwi 1352 tests；部署验证
证据入档——见 `kiwi-commerce-v1.1-release-decision-2026-08-07.md`）
方法：把 `docs/kiwi-commerce-v1.1-architecture-draft-rev1.4.1.md` §42 完成定义 21 条
逐条映射到实现代码 + 测试证据，标 ✅（直接实证）/ ⚠️（部分或间接）/ ❌（缺失）。
依据 = kiwi 仓 `main`（90 测试文件，1352 tests 全绿，`npm run verify` 含 lint/
typecheck/build/包冒烟）+ kiwi-catalog 仓 `main`（66 passed，5 skip 为 FastAPI 条件）。

**范围声明**：本审计只评估 v1.1 完成定义的就绪度，**不宣布 v1.1 发布**。
按 rev1.4.1 文档自身约定（"在 v1.1 正式发布前，本文状态始终是 Draft"），
v1.1 的发布决定（含第三方互操作证据、部署验证、产品化打磨）不在本审计内。

## 结论摘要

| 评估 | 数量 | 条目 |
| --- | --- | --- |
| ✅ 直接实证 | 21 | #1-21 |
| ⚠️ 部分或间接 | 0 | — |
| ❌ 缺失 | 0 | — |

## 逐条矩阵

| # | 完成定义 | 实现 | 测试证据 | 评估 |
| --- | --- | --- | --- | --- |
| 1 | kiwi-catalog 可独立部署，不依赖 shopping-cli 数据库 | 独立 Python FastAPI 项目（`<WORKSPACE>/kiwi-catalog`：独立 schema、shadow tables、migration v9、Docker/systemd 部署物）；`catalog_agents` 表对 merchants 仅弱引用。**部署验证（2026-08-07）**：`docker build` + 容器内全链路冒烟（health/register/search/get/suspend/reinstate/verify）通过、重启后 volume 数据保留；venv 安装 + `kiwi-catalog-api` console script 启动冒烟（systemd ExecStart 等价路径）通过 | `test_kiwi_catalog_service.py`（独立库端到端）、`test_fastapi_dualstack.py`、`test_shadow_tables.py`（缺影子行不崩 + 迁移路径表集合一致） | ✅ |
| 2 | Kiwi AgentDiscovery 可使用 KiwiCatalogSource | `src/discovery/catalog-source/kiwi-source.ts`（/v1/agents 消费端）+ `CatalogSource` 接口化（`resolve.ts` resolveViaCatalog 可互换） | `tests/kiwi-catalog-source.test.ts`（searchRecords/searchCandidates/getCandidate + resolveViaCatalog 集成 2 例） | ✅ |
| 3 | Direct well-known discovery 在没有 kiwi-catalog 时仍可工作 | `resolve()` 的 well-known 路径零改动（catalog 是可选 deps）；既有 1341→1361 tests 全绿为回归证据。**fetchCard 复用 UCP 级 SSRF 防护**（assertSafeTargetUrl + 请求前 DNS 复查 + redirect:manual 禁重定向），catalog 驱动的 agent_card_url 与 domain 路径同受保护 | `tests/discovery-catalog-source.test.ts`（resolveViaCatalog 可选性 + SSRF 拒绝 2 例）、`tests/discovery-resolve.test.ts`（直连路径） | ✅ |
| 4 | shopping-cli 不再承担 network Agent Catalog authority | 服务边界证据：Agent Catalog 已整体迁出为独立 kiwi-catalog 项目（`/v1/agents` 三态域 + 独立 schema）；TS 侧 `ShoppingCliCatalogSource` 降级为 legacy 消费端 | `test_kiwi_catalog_v1_api.py::test_legacy_route_consumes_v1_registered_agent`（v1 register → legacy 搜索命中 + 折叠状态一致，消费端可用性）、`test_merchant_single_agent.py` | ✅（2026-08-07 legacy 消费端用例补齐） |
| 5 | shopping-cli 可作为 Merchant CommerceDataSource | **架构调整（2026-08-07）**：kiwi merchant 只与 shopping-cli 沟通——数据接入整体下沉 shopping-cli 仓；kiwi 侧保留 `CommerceDataSource` 接口（数据侧边界，≠ CommerceClient ≠ CounterpartyChannel）+ `ShoppingCliCommerceDataSource` 唯一入口（GET /products/{sku} + /search/products，price 元→minor，UPSTREAM_PROXY，404→undefined） | `tests/commerce-data-source.test.ts`（信封解析/元→minor/404/结构错误/网络） | ✅ |
| 6 | shopping-cli 至少支持一种本地数据库源 | shopping-cli 原生 `products` 表（source='local'，LOCAL_AUTHORITATIVE——录入即事实；migration v16 加 source 列） | shopping-cli 仓 `tests/test_erp_data_source.py`（本地权威行与 ERP 冲突时不被覆盖） | ✅（证据落点：shopping-cli 仓，2026-08-07） |
| 7 | shopping-cli 至少支持一种 ERP / external business data adapter | shopping-cli 仓 `shopping_cli/data_sources/erp_source.py`：分页拉取 ERP → upsert 本地 products 表（source='erp'，UPSTREAM_PROXY 缓存）+ 本地手改行冲突跳过（绝不静默合并冲突权威源）+ fail-closed | shopping-cli 仓 `tests/test_erp_data_source.py`（7 例：upsert 标注/覆盖/冲突跳过/网络/非 2xx/坏形状/缺 merchant） | ✅（证据落点：shopping-cli 仓，2026-08-07） |
| 8 | Merchant private data 不进入 kiwi-catalog | TS 契约 `contracts/kiwi-catalog/1.0/agent-record.schema.json` additionalProperties:false（私有字段在 schema 层拒绝）；Python register 只读取白名单字段（display_name/hosting_mode/handoff/capabilities/skills），未识别字段不落库 | `tests/kiwi-catalog-source.test.ts`（私有字段 contract_violation）、`test_kiwi_catalog_v1_api.py`（record 无私有字段） | ✅（注：新 API register-input 的 schema 硬拒未落盘，依赖白名单读取实现） |
| 9 | Agreement 可生成 HandoffCandidate | `handoff_agreement` 工具（selected_nonbinding 任务 → createHandoffCandidate）+ `src/handoff/candidate.ts` | `tests/handoff-candidate.test.ts`（构造即校验）、`tests/handoff-e2e.test.ts`（全链路） | ✅ |
| 10 | HandoffCandidate 绑定 agreement/terms digest/destination/identity | candidate 构造即校验：agreement_id/negotiation_id、terms_digest 重算比对、destination 词表、buyer/merchant identity ref。**review 修复**：`requireIsoTimestamp` 校验 Date.parse 真实可解析（越界时间戳如 `2026-13-01` 构造即拒，全库 40+ 调用点受益）；`validateHandoffCandidate` 重建路径同样走可解析校验 | `tests/handoff-candidate.test.ts`（digest 一致性/篡改拒绝/身份 ref） | ✅ |
| 11 | Handoff 支持至少 external URL、PO/quote/contact 中三类目的地 | `DESTINATION_TYPES` 11 值（external_checkout_url/platform_deep_link URL 类 + quote/PO/contact 文档类）；执行层对非 URL 类不做 URL 探测（isUrlDestinationType 门控） | `tests/handoff-e2e.test.ts`（**E2E 实证 4 类**：external_checkout_url + quote_document + purchase_order_draft + merchant_contact，参数化用例）、`tests/handoff-stale-revalidation.test.ts`（external URL 路径） | ✅（2026-08-07 补齐 PO/contact E2E） |
| 12 | Handoff 不创建订单 | executeHandoff 无订单路径；TransactionHandoff.creates_order 恒 false | `tests/handoff-stale-revalidation.test.ts`（事件序列无 order/payment/inventory）、`tests/handoff-e2e.test.ts`（断言） | ✅ |
| 13 | Handoff 不授权支付 | 同上（authorizes_payment 恒 false） | 同上 | ✅ |
| 14 | Handoff 不预留库存 | 同上（reserves_inventory 恒 false） | 同上 | ✅ |
| 15 | 目的 URL 有 HTTPS / redirect / phishing 防护 | `src/handoff/url-safety.ts`（HTTPS 默认/unsafe scheme 拒绝/userinfo 拒绝/expectedHost+allowlist 绑定/**请求前 DNS 复查防 rebinding**/重定向每跳重验/**2xx 终点门（死链不交付展示）**/**3xx 无 Location、非 3xx 带 Location 均 fail-closed**/maxRedirects）+ executeHandoff 集成（仅 URL 类目的地） | `tests/handoff-url-safety.test.ts`（14 例全矩阵，含 DNS 复查拒绝零探测/404 死链/302 无 Location/非 3xx 带 Location） | ✅ |
| 16 | stale Agreement 或 destination 可使 HandoffCandidate 失效 | executeHandoff §10 revalidation：agreement 消失/身份变化/terms_digest 不匹配/expiry/目的地无效 → stale/expired 事件 + 不执行。**review 修复**：expiry 门 Date.parse NaN fail-closed（不可解析时间戳按过期处理，`2026-13-01` 类输入无法绕过）；write-gate `readPreconditions` 真实重读 agreement（terms_digest 比对，approval 与执行间协议被改写 → 候选 supersede）；执行失败（{ok:false}）不再标 executed | `tests/handoff-stale-revalidation.test.ts`（4 例）+ `tests/agent-negotiate-buyer-task.test.ts`（superseded 语义） | ✅ |
| 17 | 用户能看到 Handoff 目标和已谈妥摘要 | `display_summary`（merchant + summary）+ kernel `handoffSummary` getter（/handoff 命令，Ledger 投影）+ 工具交付文本 | `tests/handoff-tui.test.ts`（真实 kernel + runChatTui 注入流：/handoff 输出候选 id/生命周期/目的地/商家/摘要）、`tests/handoff-e2e.test.ts`（交付文本断言） | ✅（2026-08-07 TUI 集成测试补齐） |
| 18 | Ledger 可审计 Handoff created/delivered/opened/expired | `HandoffEventStore`（复用 LedgerStore 引擎：append-only/hash-linked/verifyChain/禁词）+ 12 个 handoff event kinds + **digest 覆盖修复**（篡改 terms_digest/evidence 可检出）。**review 修复**：destination 合并不再允许调用方覆盖候选 type/ref（审计目的地与候选内容强制一致）；交付观察层状态机（opened_confirmed/revoked 需 delivered 前置事件，delivery_failed 不产生观察状态）；created 事件移至审批通过后落链（/reject 的候选不留悬空 PROPOSED） | `tests/handoff-ledger.test.ts`（事件过滤/evidence 落链/篡改检出/事件重建/禁词）+ `tests/handoff-delivery.test.ts`（前置状态门） | ✅ |
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
4. **expiry 门 Date.parse NaN fail-open**：`requireIsoTimestamp` 原只验正则不验可解析
   性，`2026-13-01T00:00:00Z` 类越界时间戳 NaN < x 恒 false、候选永不过期直接交付——
   已改为构造即校验真实可解析（#10 实证加强），executeHandoff 过期门保留
   Number.isFinite 双保险（#16）。
5. **幂等 check-then-act 并发保护**：executeHandoff 的 lookup→(await)→record 非原子，
   并发执行可双重交付并产生 CONSUMED→STALE 非法事件序列——已加 `withCandidateLock`
   候选粒度原子文件锁（单进程 async 交错与跨进程共享 dir 均互斥，持锁超时
   fail-closed），并补 4 个并发测试。
6. **url-safety DNS 复查**：HEAD 探测前对主机名做请求前 DNS 复查（防 rebinding 到
   保留网段），此前只覆盖字面 IP（#15 实证加强）；另加 2xx 终点门（404/500 死链
   不再作为"已验证目的地"交付展示）。
7. **协议级去重**：`handoff_agreement` 对同 (negotiation, destination) 已交付事件
   拒绝重复——LLM 重试生成新候选（新 digest）绕过幂等键导致同协议二次交付/二次
   URL 探测的路径堵住（#20/#21 口径保真）。
8. **交付观察层无状态机**：opened_confirmed/revoked 原可直接落链（审计可被污染）、
   delivery_failed 投影倒退状态——已加 delivered 前置门 + 投影修正（#19 证据门
   的落地面加固）。
9. **授权证据时间戳字符串比较**：RFC 3339 带时区偏移时字符串比较可跨时区 fail-open
   （事后补签证据被接受）——已改 Date.parse 数值比较 + NaN 守卫。
10. **operator-approval 纯内存**：审批记录（"谁在何时确认了哪个 package/session"）
    重启即失且无审计落盘——已支持 JSONL 持久化（目录 0700/文件 0600，重启重放）。

## 声明

- v1.1 完成定义 21 条：**21 条直接实证、0 条部分、0 条缺失**。
- v1.1 完成定义 21 条已全部直接实证（2026-08-07）。
- 本审计**不宣布 v1.1 发布**。v1.1 仍为 Draft（rev1.4.1 §0）；发布前还需：
  v1.1 就绪度审计随发布决策复核、第三方互操作证据（文档明确禁止宣称，维持）。
