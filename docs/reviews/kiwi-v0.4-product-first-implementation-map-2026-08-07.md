# kiwi-catalog v0.4 Product-first 实现核对表

> 日期：2026-08-07。三仓实现（M1–M5）落地后的完成定义映射。
> **不宣布发布**：v1.1 仍为 Draft；本表是 rev1.5 CD #22–28 / v0.4 DoD /
> shopping-cli v0.3 DoD 到代码与测试的证据映射，供发布审计复用。

## kiwi-catalog v0.4 DoD（21 条）

| DoD | 证据 |
|---|---|
| 1. 既有 Agent Catalog API 向后兼容 | 全量回归 118 passed/6 skipped；legacy 路由零改动 |
| 2. 既有 verification/security 测试保持绿 | 同上 |
| 3. Product/CapabilityListing 冻结公开契约 | `contracts/kiwi-catalog/1.0/listing-record.schema.json`（M1）|
| 4. Listing 不含私有 Merchant 字段 | schema additionalProperties:false + `listings/contracts.py` FORBIDDEN_FIELDS + `test_listings_domain.py` |
| 5. owner_agent_id 可解析到当前 Agent Card | `/v1/agents/{id}` + `resolveViaCatalog` fresh verify（M3 E2E）|
| 6. ProductListing 支持稳定 source_product_ref | publish 契约必填 + partial unique upsert |
| 7. CapabilityListing 不要求虚构 SKU | `test_capability_projection_has_no_fake_sku` + contract 测试 |
| 8. /v1/listings/search 支持 q/category/region/type/cursor | `test_listings_search.py` |
| 9. authority=discovery_projection | 序列化器恒值 + schema enum 锁定（M1 词表测试）|
| 10. requires_direct_confirmation=true | 同上 |
| 11. Listing freshness 独立于 Agent freshness | 两套词汇（FRESH/STALE vs fresh/stale/unreachable）+ 组合测试 |
| 12. Agent suspension suppresses owned Listings（两件事）| `policy.suspend_owned_listings` + search join 排除 + `test_agent_suspend_marks_owned_listings_suspended` |
| 13. publish 复用 owner auth/idempotency/rate-limit/audit | `handlers/listings.py` 五步幂等模板 |
| 14. Merchant 可 withdraw | `/v1/listings/{id}/withdraw` + 测试 |
| 15. shopping-cli 生成 PublicListingProjection | `shopping_cli/listings/projection.py`（M4）|
| 16. Buyer 可搜索商品并解析 Merchant Agent | `KiwiCatalogSource.searchListings` + shortlist 工具（M3）|
| 17. Buyer 在 Direct A2A 前 revalidate Agent/Card | `resolveViaCatalog` 全链（既有）+ M3 E2E 复用 |
| 18. Direct Inquiry/RFQ 用权威 Merchant 侧数据 | M3 E2E：Offer 价格来自 merchant productSource 桩 |
| 19. Catalog hint 永不视为 Offer/库存预留 | 契约标注 + `requires_direct_confirmation` 恒 true |
| 20. E2E：Need → Listing → Agent → Direct A2A → Offer | `tests/product-first-e2e.test.ts`（CD #28）|
| 21. fresh_until 到期自动 STALE（惰性翻转）| on-read UPDATE + `test_expired_listing_flips_to_stale_on_read` |

## rev1.5 CD #22–28

| CD | 证据 |
|---|---|
| #22 kiwi-catalog 支持 Product/CapabilityListing | M2（kiwi-catalog 仓）+ M1 schema |
| #23 Listing 绑定 owner_agent_id，不复制 endpoint | wire 形状 + `listing_search_result` 只带 agent 投影（无 endpoint）|
| #24 discovery projection + Direct confirmation 标记 | M1 schema 锁定 + 序列化器恒值 |
| #25 Listing freshness 与 Agent freshness 分离 | 词汇隔离 + 组合测试 |
| #26 shopping-cli 生成 public-only PublicListingProjection | M4 projection.py + `test_listing_projection.py` |
| #27 Buyer 从 ProductIntent 完成 Listing Search → resolution | M3 ProductIntent + search_listings + negotiate 注入 |
| #28 Product-first E2E 到 KNP Offer | `tests/product-first-e2e.test.ts`（9900 minor 来自 merchant 桩）|

## shopping-cli v0.3 DoD（6 条）

| DoD | 证据 |
|---|---|
| 1. 至少一种数据源输出 ProductListing projection | `project_product_listing`（local/ERP 两源）|
| 2. private 字段不进 projection 回归 | `test_projection_is_public_only_doD2` |
| 3. projection 带 source_ref/source_revision/freshness | `test_projection_carries_source_revision_and_freshness_doD3` |
| 4. 同内容 digest 不重复发布 | `test_same_digest_not_republished_doD4`（镜像表）|
| 5. 停止公开触发 withdraw | `test_reconcile_withdraws_inactive_products_doD5` |
| 6. Merchant Kiwi 可发布到 kiwi-catalog v0.4 | 真实联调：publish-listings → 3 条发布 → 搜索召回 → 去重（M5）|

## 真实联调记录（M5 冒烟）

- kiwi-catalog（docker :8600，KIWI_CATALOG_OWNER_TOKEN_SECRET=live-secret）
- shopping-cli `listings publish-listings`（3 条 product projection）
- `/v1/listings/search?q=Touch` → 3 条，authority/confirm/owner 全对
- 重复 publish → 0 发布 3 跳过（digest 去重）
- 期间发现并清理：宿主 8600 端口被旧本地进程占用（容器内服务本身正常）

## 已知留白（本轮不做，见方案）

draft/apply 写意图（签名 fail-closed）；scheduled refresh/webhook；refresh
webhook（catalog→publisher）；listing CLI 子命令（kiwi-catalog 侧）；FTS/
vector；bulk-publish；listing_public_snapshots；反向抓取 ERP；声誉排序；
Postgres/PIM/CSV adapter；冷启动播种脚本（运营事项）；发布 v1.1 声明。
