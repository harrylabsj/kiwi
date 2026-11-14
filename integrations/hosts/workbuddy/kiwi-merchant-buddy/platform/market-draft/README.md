# 市场配置草稿（WP19；WP25 随 1.8.0 四场景重排；1.8.1 修正资产 ID 与对外表述；1.8.2 合并线上 V5 品牌与提示词）

平台「市场配置」页实测要求：**配置专家（必填）至少 5 个专用专家，公共专家数量不得超过专用专家**；「启用专家团」「启用精选场景」默认打开，打开时分别要求配置专家团、精选场景（≥4 个，每个可关联 ≤3 个专家/专家团）；专家分类/专家团分类选填（填则 ≥3 个）。

> **2026-11-14 平台核对警告**：线上 V5 的市场配置使用平台内部专家 ID（`ex_...`），且 4 个精选场景各关联 **3 个**专家/专家团；本目录草稿使用 `oe_...` 资产 ID、每场景 2 个。两者不是同一份数据。**不要把本目录的 `market.json` / `platform-pack.zip` 直接覆盖线上市场配置**；更新市场配置时应以平台导出为基线，人工核对后再改。

本目录是按该要求准备的**填写底稿**：

- `market-draft.json`：中英双语草稿（由 `platform/build-platform-pack.mjs` 生成，**勿手改**——改内容请改生成器常量 `MARKET_EXPERTS` / `MARKET_EXPERT_TEAM` / `MARKET_SCENARIOS` / `MARKET_EXPERT_CATEGORIES` / `SCENE_EXPERT_IDS` 后重新生成，行业配置包里的胶囊 `expertId` 与 zip 包 `market.json` 同源）。
- 平台导入用的两个产物：`platform/out/market.json`（与草稿同一内容源）与 `platform/out/platform-pack.zip`（内含 `<templateId>/industry-config.json` + `<templateId>/icons/` + `market.json`），用于验证 zip 导入是否随包带图标。

## 内容清单（WP25：随 1.8.0 四工作场景重排）

| 项 | 数量 | 说明 |
|---|---|---|
| 专用专家 | 5 | 开通顾问（注册开通）/ 报价助理（商品报价）/ 运营分析师（运营分析数据类胶囊）/ 客服教练（运营分析客服类胶囊）/ 洽谈审批官（审批磋商），共覆盖 26 个胶囊 |
| 公共专家 | 0 | 无（满足「公共 ≤ 专用」） |
| 专家团 | 1 | 「Kiwi开店团队」= 5 位专用专家全体，协调者口径在 `systemPrompt` |
| 精选场景 | 4 | 第一次开店 / 上架商品和报价 / 看懂运营数据 / 处理审批与洽谈（各关联 2 个专家/专家团） |
| 专家分类 | 5 | 开通上手 / 商品报价 / 数据增长 / 客服接待 / 审批磋商（填则 ≥3 的要求已满足） |
| 专家团分类 | 0 | 仅 1 个团队填不满 ≥3 个分类，留空（选填） |

**首发边界（WP25，运营分析师与洽谈审批官尤其相关）**：运营明细、洽谈过程与待审批项都在商家自己的云端实例工作台（运营报告 / 旁观洽谈 / 审批与规则表单）；按「网关不碰实例」原则首发阶段不直连实例，专家引导商家打开工作台、帮解读与起草，不编造访客数、询价数、洽谈内容或审批结果；Buddy 内直连实例为第二版（WP16）。

## 系统提示词边界

每位专家/专家团的 `systemPrompt` 由生成器统一追加同一段边界尾注（`EXPERT_BOUNDARY_APPEND`）：

- 网关不碰实例：不经网关读写商家实例的运营数据（询价明细、商品表、审批记录等）；
- 上线判断只认 `kiwi_catalog_get_service_status`；
- 不代商家点击任何费用或授权弹窗，不伪造任何回执；
- 不在对话里收集密码、邮箱验证码、配对码、密钥或 token。

生成器校验强制：专家提示词只允许引用 `kiwi_catalog_*` 只读网关工具与三个已知技能（`kiwi-cloud-deploy` / `kiwi-product-import` / `kiwi-merchant-cs-prep`）。

## 资产 ID 与审核状态（带日期观察，非实时）

专家/专家团使用平台已创建的市场资产 ID。下列状态是历史观察，**不代表当前平台可用**；对外表述与提交前必须以 WorkBuddy 页面为准：

| 资产 | ID | 状态 |
|---|---|---|
| 开通顾问 | `oe_eee5ab6349f00203` | 0.1.2 线上已发布；0.1.8 审核中（2026-11-12 提交） |
| 报价助理 | `oe_a2d0c6cc725719bd` | 2026-10-27 盘点已发布 |
| 运营分析师 | `oe_85c8bf08203ad422` | 2026-10-27 盘点已发布 |
| 客服教练 | `oe_ee7df761fbcdefee` | 2026-10-27 盘点已发布 |
| 洽谈审批官 | `oe_8033777b83a3de05` | 2026-10-27 盘点已发布 |
| Kiwi开店团队（专家团） | `oe_a1da12ace3d9c62c` | 2026-10-27 盘点已发布 |

回填位置：生成器 `MARKET_EXPERTS`（5 位专家）/ `MARKET_EXPERT_TEAM`（团队）与 `SCENE_EXPERT_IDS`（26 个胶囊的 `expertId`，行业配置包同源）；状态文字集中在生成器 `MARKET_ASSET_REVIEW_STATUS` 一处，状态变化改这一处并重新生成。

## 占位 id 与待回填（勿当成真实 id 提交平台）

- 精选场景 `scn-*` 仍为**占位 id**（专家/专家团 id 已按上节回填）：平台创建真实记录后，回填生成器 `MARKET_SCENARIOS` 后重新生成。
- 技能资产 ID：`kiwi-cloud-deploy`（`os_1ea25f81ce98fea3`）、`kiwi-product-import`（`os_32c612d72d2c3bcd`）、`kiwi-merchant-cs-prep`（`os_dc3a52407574eb77`）均已回填；生成器强制校验 16 位 `os_` 资产，不再接受 `pending:` 占位。提交前仍需核对平台当前审核/发布状态。
- `header.title` 分隔格式（当前 `HOME_TITLE_SEPARATOR = "·"`）与 `titleEn` 字段名待导入实测确认（`docs/.../platform-ref/` 为空，无已存资料）。
- `market.json` 字段名为按平台表单反推的近似格式（`experts` / `expertTeams` / `featuredScenarios` / `expertCategories` / `enableExpertTeams` / `enableFeaturedScenarios`），以 zip 导入实测为准，不符则改生成器 `buildMarketPack()`。
- 专家头像与精选场景图标：平台若要求，另行补充（当前草稿不带图标字段）。

## 平台操作顺序建议

1. 先导入 `platform/out/industry-config.json`（或直接试 zip 导入 `platform/out/platform-pack.zip`，验证图标是否随包）。
2. 在市场配置页按本草稿创建 5 个专用专家 → 专家团 → 4 个精选场景 → 专家分类；分类名与专家名称以草稿中英文字段为准。
3. 专家/专家团真实 id 已回填（见「资产 ID 与审核状态」）；精选场景创建完成后把真实 id 回填生成器并重新生成，再导入一次使胶囊 `expertId` 指向真实专家。
4. 预览逐项核对（胶囊归属专家、场景关联、启用开关）。
