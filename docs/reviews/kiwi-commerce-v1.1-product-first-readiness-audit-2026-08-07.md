# Kiwi Commerce v1.1 Product-first Discovery 就绪度审计（CD #22–28）

Created: 2026-08-07
方法：把 `docs/kiwi-commerce-v1.1-architecture-draft-rev1.5.md` §42 完成定义
**#22–28**（rev1.5 新增的 Product-first Discovery 部分）逐条映射到实现代码 +
测试证据，标 ✅（直接实证）/ ⚠️（部分或间接）/ ❌（缺失）。依据 = 三仓
`main` 当前状态：kiwi 仓（92 测试文件，1378 tests 全绿，`npm run verify`
含 lint/typecheck/build/包冒烟）+ kiwi-catalog 仓（118 passed / 6 skipped，
FastAPI 条件 skip）+ shopping-cli 仓（1170 passed / 11 skipped）。

**范围声明**：本审计只评估 rev1.5 CD #22–28 的就绪度，**不宣布 v1.1 发布**。
CD #1–21 的审计仍由 `kiwi-commerce-v1.1-readiness-audit-2026-08-07.md`
（rev1.4.1 基线，21/21 直接实证）管理；发布决定（第三方互操作证据、
产品化打磨）不在本审计内。

## 结论摘要

| 评估 | 数量 | 条目 |
| --- | --- | --- |
| ✅ 直接实证 | 7 | #22–28 |
| ⚠️ 部分或间接 | 0 | — |
| ❌ 缺失 | 0 | — |

## 逐条矩阵

| # | 完成定义 | 实现 | 测试证据 | 评估 |
| --- | --- | --- | --- | --- |
| 22 | kiwi-catalog 支持 ProductListing 与 CapabilityListing | wire 契约 `contracts/kiwi-catalog/1.0/listing-record.schema.json`（listing_type enum、per-type 条件：product→source_product_ref 必填、capability→禁止 handoff_destination_types）；kiwi-catalog 仓 `commerce_listings` 表（migration v10）+ `listings/` 包（contracts 白名单/行级幂等 upsert 双轨/digest）+ `POST /v1/listings/publish` | kiwi 仓 `tests/listing-contracts.test.ts`（19 例：词表/向量/私有字段拒绝）；kiwi-catalog 仓 `tests/test_listings_domain.py`（publish 契约 16 例）+ `tests/test_listings_api.py`（product/capability 发布、capability 无 SKU、publisher_listing_key upsert） | ✅ |
| 23 | Listing 搜索结果绑定 owner_agent_id，不复制 endpoint 作为 authority | listing wire 必含 `owner_agent_id`（schema required）；搜索结果 agent 投影只含 catalog_agent_id/verification/freshness/admin 四字段（无 endpoint）；Buyer 经 `owner_agent_id → getRecord → resolveViaCatalog` fresh verify（候选元数据不被直接信任） | `tests/listing-contracts.test.ts`（required 字段断言）；`tests/product-first-e2e.test.ts`（searchListings → owner_agent_id → negotiateWithAgent 注入 KiwiCatalogSource → fresh verify 真实拉取 Agent Card）；kiwi-catalog 仓 `tests/test_listings_api.py`（owner token 绑定/未知 owner 404） | ✅ |
| 24 | Listing 明确标记 discovery projection 且需 Direct confirmation | schema 锁定 `authority` enum=["discovery_projection"]、`requires_direct_confirmation` const=true（单值枚举防漂移）；Python 序列化器恒值构造 | `tests/listing-contracts.test.ts`（authority/const 断言 + 缺失/篡改拒绝）；kiwi-catalog 仓 `tests/test_listings_search.py::test_search_result_shape_has_authority_and_confirm_flags`；`tests/product-first-e2e.test.ts`（stub 响应过 schema 校验防漂移） | ✅ |
| 25 | Listing freshness 与 Agent freshness 分离 | 两套词汇拼写隔离（listing 大写 FRESH/STALE vs agent 小写 fresh/stale/unreachable，schema enum 无交集）；`commerce_listings.listing_freshness_state` 独立列 + on-read 惰性翻转（fresh_until < now → STALE，无后台进程）；TTL 默认 product 24h / capability 7d（publisher 声明优先） | `tests/listing-contracts.test.ts`（词汇隔离断言）；kiwi-catalog 仓 `tests/test_listings_search.py`（过期翻转写回、freshness_state 过滤、republish 刷新）；`tests/product-first-e2e.test.ts`（listing FRESH + agent fresh 合法组合） | ✅ |
| 26 | shopping-cli 能生成 public-only PublicListingProjection | shopping-cli 仓 `shopping_cli/listings/projection.py`（projectProductListing/projectCapabilityListing/listPublishableListings + strip_provenance）；private 字段永不进入投影（显式白名单构造，非 strip）；availability/price hint 带 provenance 注明 discovery hint；只读 API `GET /v1/merchant/listings/*` | shopping-cli 仓 `tests/test_listing_projection.py`（6 例：DoD #2 私有字段回归、provenance 携带、active=0 排除、capability 无假 SKU、strip 白名单） | ✅ |
| 27 | Buyer 可从 ProductIntent 完成 Listing Search → Merchant Agent resolution | kiwi 仓 `ProductIntent` 类型 + `search_listings`/`shortlist_listing` 工具（catalogSource 注入式挂载）；`KiwiCatalogSource.searchListings/getListing`（查询键白名单 fail-closed、分页去重、逐元素 schema 校验）；`negotiateWithAgent` catalog source 注入化（listing → owner_agent_id → getRecord → resolveViaCatalog 全链） | `tests/kiwi-catalog-source.test.ts`（listing 方法 4 例：解析/未知键/私有字段拒绝/getListing）；`tests/product-first-e2e.test.ts`（search_listings → shortlist → owner resolution 到 Direct A2A） | ✅ |
| 28 | 至少一个 Product-first E2E 达到 Need → Listing → Direct A2A → KNP Offer | `tests/product-first-e2e.test.ts`：startTestA2aStack（listing stub 过 schema 校验）→ searchListings → owner_agent_id → negotiateWithAgent（注入 KiwiCatalogSource）→ resolveViaCatalog fresh verify → Direct A2A → KNP Offer；**Offer 价格来自 merchant productSource 桩（99.00 元 = 9900 minor），不是 catalog hint**——Source-of-Truth boundary 实证 | `tests/product-first-e2e.test.ts`（3 例：stub 契约校验/CD #24 常量、E2E 到 Offer、freshness 独立组合）；真实联调（2026-08-07 M5）：docker 起 kiwi-catalog → shopping-cli `listings publish-listings` 3 条 → `/v1/listings/search?q=Touch` 召回 3 条（authority/confirm/owner 全对）→ 重复发布 0 发 3 跳（digest 去重） | ✅ |

## 审计注记（实现中修复的地基问题）

1. **cursor 分隔符被 ISO 时间戳截断**（kiwi-catalog）：cursor 编码原用 `:` 分隔，
   ISO 时间戳含冒号导致 `split(":", 1)` 截断时间、分页漏行——已改 `|` 分隔
   （search.py + sqlite_repository.py 两处），cursor 翻页稳定测试锁定
   （`test_cursor_pagination_is_stable`：同秒多行不重不漏）。
2. **SQLite JSON1 类型不匹配**：`json_extract(...) >= json('50')` 中 `json()` 返回
   TEXT 与 INTEGER 比较恒 false——moq/布尔过滤全失效。已改为直接绑定 Python
   原值（int/1-0），`json('50')` 包装不再使用（`test_search_commercial_hints_json1_filters`）。
3. **FastAPI 默认参数空字符串炸数值过滤**：FastAPI 路由所有 query 参数默认 `""`，
   `int("")` 抛 400——空串视为未提供（search.py 空值保护），dualstack 测试锁定。
4. **attribute 过滤路径注入**：`attribute.<path>` 过滤键经路径格式白名单
   （[A-Za-z0-9_] 段、深度 ≤3）防 json_extract path 注入（测试含 drop table 向量）。
5. **shopping-cli emit 签名**：projection CLI 的 emit 缺 format 参数（text/json）
   炸 TypeError——补齐（`cli_listing_commands.py`）。
6. **verify.sh npm ≥11 兼容**：`npm pack --json` 输出从数组变对象，
   `[0]` KeyError——双形态兼容（`scripts/verify.sh`）。
7. **宿主端口占用**：M5 联调时 127.0.0.1:8600 被旧本地进程占用、curl 打到旧
   代码——容器内服务本身正常；清理后联调通过。运维注意：多进程/容器并存时
   端口占用排查。

## 遗留（不在 #22–28 审计范围）

- CD #1–21：rev1.4.1 基线审计（21/21 直接实证）另行管理；
- 发布决定：第三方互操作证据、v1.1 发布声明（用户决策）；
- 冷启动：v0.4 §23 ≥20 条真实 Listing 播种（运营事项）；
- 后置 MAY 项：FTS/vector、bulk-publish、refresh webhook、快照表。
