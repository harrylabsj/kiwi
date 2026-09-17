# 第 0 版 M0 开发任务：商家发布基本资料 → 采购专家发现商家

状态：待开发任务说明（2026-09-17）。本文件可独立用于排期；接口名称为建议，实施时以仓库现有契约和代码评审为准。

## 一句话目标

一个**没有安装 Kiwi Merchant 或 `shopping-cli` 专属服务器**的商家，仅通过 Kiwi Merchant Buddy 引导注册 `kiwi-catalog`、填写并发布商家及至少一个商品名，就能被 WorkBuddy 中已发布的“Kiwi 采购询价”专家按商品词搜索到。

M0 只解决“注册、公开发布、发现”。买家订阅、公开动态拉取、实时询价、自动客服、淘宝/京东 API 同步均不在本任务范围；商家可继续照常经营现有店铺。

## 已有基础与缺口

| 仓库 | 已有 | M0 缺口 |
| --- | --- | --- |
| `~/coding/kiwi-catalog` | `/portal/register`、`/v1/accounts/register` 与邮箱验证；注册产生稳定 `merchant_id`；已有 Agent/Listing 搜索 | 没有“无需 Merchant Agent 的商家公开资料/商品名”发布与搜索；现有 Listing 需要 publisher Agent 和 owner token，不能把注册账户直接当作可搜索的 Agent |
| `~/coding/kiwi` | `KiwiCatalogMerchantIndex`、买方 `kiwi_search` 与 WorkBuddy 采购专家 | `kiwi_search` 只聚合现有 Agent/Listing；结果没有区分“资料可查”和“可实时询价”的类型；必须防止第 0 版商家被送进 RFQ 流程 |
| WorkBuddy 商家 Buddy | 首页配置草稿和第 0 版 AI 客服准备 Skill 草稿 | 需要一个清楚的注册/发布入口与成功/失败状态；无需先绑定商家专属 MCP |

## 工作包 A：`kiwi-catalog` 基本资料发布与搜索

1. **复用账号身份**：已验证商家登录后，从服务端会话取得 `merchant_id`。M0 不要求用户申请 Agent/Listing 所用的 owner token，更不能在 Buddy 配置或提示词里存管理员令牌。
2. **新增公开资料记录**：最少包含 `publication_id`、`merchant_id`、公开商家名称、商品名、可选类目/简介/公开店铺链接、`status`（draft/published/withdrawn）、`source=merchant_declared`、版本、发布时间和更新时间。私有电话、邮箱、价格底线和账户凭据不能从注册表自动进入公开投影。
3. **发布流程**：商家可保存私有草稿；公开预览后明确确认发布。写入必须校验会话归属、必填字段、内容长度、链接安全、幂等和限流；更新与撤回留下审计记录。未经发布、已撤回、已过期或被治理挂起的资料不得进入正常搜索。
4. **公开搜索**：支持按商品名搜索，返回命中的商家与商品基本信息、`merchant_id`、`publication_id`、来源/更新时间，以及 `inquiry_available=false`。结果排序和分页遵循 catalog 既有搜索约定。公开资料不应生成虚假的 Agent Card、A2A 地址或实时报价。

建议接口（可按现有路由结构调整）：

```text
POST /v1/merchant-publications           已登录商家保存草稿/确认发布
GET  /v1/merchant-publications/search    买家按商品词读取已发布资料
GET  /v1/merchant-publications/{id}      读取公开详情
POST /v1/merchant-publications/{id}/withdraw  商家撤回
```

商家可先通过 catalog 现有 `/portal/register` 完成注册；M0 需要在门户增加基本资料表单及“发布成功”回执，或提供等效的已鉴权页面。Buddy 只引导打开该页面和返回应用，不自行收集目录账户密码。

## 工作包 B：`kiwi_search` 接入与专家表达

1. 在 `kiwi/src/discovery/catalog-source/` 增加上述公开搜索的只读客户端和 DTO；在 `kiwi/src/buyer-core/merchant-index.ts` 同时查询现有 Agent/Listing 与 M0 公开资料。
2. 扩展 `kiwi_search` 的返回投影：M0 商家显示 `资料可查`、商家声明来源、更新时间和公开店铺入口；现有可路由商家仍显示 `可实时询价`。合并时按 `merchant_id` 去重，保留与查询词匹配的商品名；不能因为 M0 静态资料把原有实时能力降级。
3. 买方 `kiwi_request_quotes` 的路由/授权层需显式拒绝仅有 M0 资料、没有可路由 Agent 的 `merchant_id`；不只依赖专家提示词避免误调用。拒绝结果要能解释“该商家目前仅公开资料，尚未开通 Kiwi 实时询价”。
4. 更新 `integrations/hosts/workbuddy/kiwi-procurement-expert/` 的说明：买家可主动查 M0 资料及原店铺链接；不得声称已取得库存、报价或已向该商家发出 RFQ。没有搜索结果时如实说明。

本任务保持现有 `kiwi_search(query, category?, region?)` 输入接口；新增结果字段须对现有消费者兼容，并覆盖工具返回大小限制。新目录接口不可用时，可以保留仍可用的旧 Agent/Listing 结果，但须标注该来源暂不可用；两侧都失败时不得凭模型记忆补出商家。

## 工作包 C：WorkBuddy 商家侧引导与联调

Buddy 第 0 版入口文案：“注册 Kiwi 商家目录 → 填写商家及商品基本资料 → 审核并发布 → 用采购专家搜索验证”。显示草稿、已发布、已撤回、发布失败四种状态；发布接口成功前不得显示“专家已可发现”。

WorkBuddy 内置商家 MCP 的首次绑定若挡住未部署服务器的新商家，M0 上线前应在预览态验证跳过/延后绑定流程；无法跳过时先把该连接器改为用户升级第 1 版后主动连接。现有工作树中 `buddy-app.config.json` 有进行中的修改，实施时应基于当前文件做最小合并，不覆盖其他改动。

## 验收用例与完成定义

1. 新商家完成目录注册与邮箱验证，得到 `merchant_id`；未注册或未登录者不能发布，账号 A 不能修改账号 B 的资料。
2. 已注册但只保存草稿的商家，在采购专家搜索中不可见；填写商品名并确认发布后，搜索该词可见正确 `merchant_id` 和商家名。
3. 两个商家发布同名商品时均可被发现；同一商家第 0/1 版资料在结果中不会重复成两个主体。
4. 搜索结果明确标记 M0 为商家声明资料、更新时间与“不可实时询价”；对 M0 商家尝试 RFQ 在服务层被拒绝且不产生任务/消息。
5. 撤回、过期或治理挂起后，资料不再进入正常搜索；已有第 1 版商家的搜索与 RFQ 回归测试继续通过。
6. 实机从 WorkBuddy 商家 Buddy 开始注册/发布，再在已发布的采购专家中以商品词搜索，能看到同一条公开资料。保留两端截图、API 回执及 `publication_id` 作为验收证据。

## 开发顺序与交付物

先交付工作包 A 的数据库迁移、API、门户页面和测试；接口契约稳定后交付工作包 B 的查询合并、RFQ 硬门和专家说明；最后交付工作包 C 的 Buddy 引导与 WorkBuddy 实机验收。发布生产前各仓库独立测试，并验证目录回滚不会污染现有 Agent/Listing 数据。

交付物：`kiwi-catalog` 迁移/API/门户及测试；`kiwi` 只读客户端/买方结果类型/RFQ 守卫及测试；WorkBuddy 商家 Buddy 与采购专家更新包；M0 端到端验收记录。

设计背景见 [第 0 版总设计](v0-ai-cs-and-pull-subscriptions-design.md)。
