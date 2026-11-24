# WorkBuddy 的 Kiwi 商家智能体 v6 配置核对

2026-11-24 17:50（北京时间）。WorkBuddy 开放平台的应用列表显示「kiwi商家智能体」已发布 v6，最近编辑时间为 2026-11-21 17:03。在该应用的配置页执行「导出配置」，归档原始 `industry-config.json` 与 `market.json`。平台导出的是当时配置页提供的内容，应用状态页没有提供独立的逐版本包校验。

## 与 Kiwi 主库 `2510ddcf` 对比

| 主库参照 | 对比结果 |
| --- | --- |
| `platform-export/2026-11-14` 的 v5 归档 | 行业配置有 19 处字段差异，包括联系客服、模式与场景引导、技能关联和默认模型。两次导出的 `market.json` 字节一致 |
| `platform/import/industry-config.platform-import.json` | 共 6 处字段差异。来源是品牌大小写、中英文首页标题间距、英文输入提示、线上默认模型 `auto`，以及一个空的场景级提示字段。4 个模式、26 个场景、105 条模板的 ID、顺序及中英文按钮与提示词一致 |
| `platform/out/` 的生成包 | 行业配置有 5 项标准化差异，涉及中英文标题、英文占位符、授权结构和模型。线上 4 个精选场景各关联 3 个专家或专家团，本地市场草稿每个场景为 2 个 |

## 开通改版候选 1.8.3

基于 v6 原始行业配置生成 `platform/import/industry-config.platform-import.json`。首页保持四个模式，「注册开通」按 注册账号 → 邮箱验证 → 一键上云 → 发布名片 → 上线检查 → 升级接待 排列。

- 「已有账号」直接提供商家后台登录页。发布名片使用原工作台当前实例的确认页。
- 保持模板 ID；`t9` 至 `t12` 仍属于发布名片，`t13` 至 `t16` 仍属于一键上云。
- 商品导入按 SKU 更新。确认发布与导入分开，旧草稿工具只在当前会话确实可用时使用。上线检查依据名片、心跳、指定 SKU 发布和买家实测。
- 候选包保留 v6 的品牌、模型、授权、专家和图标关联。候选 ZIP 沿用原始市场配置。

本次改动涉及 Buddy 源配置、平台生成与导入脚本、顾问及部署指导。实际工作台的空商品名片发布能力、询价生效和买家侧结果依赖所部署的 Runtime，需另做端到端验证。

从 Kiwi 仓库根目录重建行业配置：

```sh
buddy=integrations/hosts/workbuddy/kiwi-merchant-buddy
node "$buddy/platform/build-platform-pack.mjs"
node scripts/export-workbuddy-config.mjs \
  --base "$buddy/platform/platform-export/2026-11-24/industry-config.json" \
  --local "$buddy/platform/out/industry-config.json" \
  --out "$buddy/platform/import/industry-config.platform-import.json" \
  --onboarding-refresh
npm run verify:workbuddy-platform
```
