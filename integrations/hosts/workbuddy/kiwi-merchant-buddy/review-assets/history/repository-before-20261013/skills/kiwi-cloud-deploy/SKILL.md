---
name: kiwi-cloud-deploy
display_name: Kiwi 云端接待部署
display_name_en: Kiwi Cloud Reception Deploy
description: Deploy the Kiwi merchant reception runtime to the merchant's own WorkBuddy cloud app in a strict order (pack verify → first sites_deploy to obtain the public URL → prepare → redeploy the same app → self-check → Catalog publish) with no-forgery rules. Use for 一键开通云端接待、升级云端接待服务、云端接待部署排障；不用于自有服务器部署。
description_zh: 按固定顺序把 Kiwi 商家接待运行时部署到商家自己的云端应用，自检并引导上线确认。
description_en: Deploy the merchant reception runtime to the merchant's own cloud app step by step, self-check, and guide the go-live confirmation.
category: devops
version: 0.2.0
author: harrylabsj
---

# Kiwi 云端接待部署

本技能把 Kiwi 商家接待运行时部署到**商家自己账号名下**的云端应用，并引导商家完成上线确认。部署归属商家（平台只有会话内发布工具，没有远程代部署 API），全程以平台真实回执为准。

平台工具口径（V1 实测，2026-09-28）：Buddy 会话**没有** inspect/activate/deploy 与云端模块开通这组工具；可用的是延迟工具 **`workbuddy_sites_deploy`（发布上线）** 与 **`workbuddy_sites_unpublish`（下线）**，加上本地文件读写与 Bash。我们不使用任何云端模块（数据库/登录/存储/LLM 都不开），因此无需 activate。**工具名与参数以平台实际提供为准**：以下步骤按功能称呼工具，执行时用会话里真实存在的发布工具与参数名；对不上时如实报告，不要猜。

固定参数：云端应用/站点名一律用「**Kiwi商家接待**」。已有就复用，**绝不新建第二个**；首次部署后的再次发布必须复用**同一个应用**（换应用会换公网域名，后续校验全部失效）。

## 硬规则（先读，任何一步都不例外）

1. **不伪造回执**：每一步只汇报平台/命令真实返回；成功、失败原文照贴，不加工成"应该成功了"。
2. **不代点弹窗**：平台发布/费用/授权确认框由商家本人点击；技能只说明弹窗含义（费用/额度以弹窗显示为准），不催促、不代确认。
3. **半公开凭据不输出**：平台回执里的 publishableKey、token 等凭据字段不贴出、不记录、不转述；只使用应用标识与公网链接这类公开字段。
4. **配额不足立即停止**：回执出现配额/云服务不可用信号（如 `cloud_service_unavailable`、`useLocalImplementation: true`）时，如实说明并停止；**不做任何本地兜底实现**，不代商家清理或升级配额。
5. **摘要不符停止**：npm integrity 或包内聚合摘要与 `references/release.json` 固定值不一致时，停止并如实报告两边的值；不换源、不换版本重试。
6. **发布失败贴原文**：`workbuddy_sites_deploy` 失败原样上报，**不修改部署包内容重试**（尤其不许改 `cloud.config.json` 的 origin）；商家决定后续。
7. **一次性口令只展示一次**：prepare `--admin-bootstrap` 打印的工作台首登口令，立即展示这一次并提醒商家保存；此后不复述、不写进任何文件或总结。口令遗失无法找回，重新部署不会重置（状态目录已有凭据时引导文件被忽略）。
8. **不承诺免费或 7×24**：费用以平台弹窗为准；不说"永久在线"——空闲回收后首个请求可能有约 3 秒冷启动。
9. **上线判断只认工具**：只有 `kiwi_catalog_get_service_status` 显示 `card.published` 且 `presence=fresh` 才能说"已上线，采购方可以发现你并发来询价"；工具不可用或结果不符时如实说明卡点。
10. **不读取、不转述配对码**：Catalog 配对码由商家本人在工作台与授权页两处核对；配对码和链接都不是授权凭证。

## 第 0 步：执行前检查

1. **确认账号已连接**：先确认商家已连接 Kiwi 商家账号（有 `kiwi_catalog_get_merchant_profile` 时调用确认；没有则询问商家是否已连接，未连接先走注册开通，再回来部署）。
2. **检查会话工具**：确认本会话是否具备平台发布工具 `workbuddy_sites_deploy`（及下线工具 `workbuddy_sites_unpublish`）。**缺失 → 转入「方案 B 兜底」**，不要尝试变通。工具存在但参数/回执与下述步骤对不上时，以平台实际为准并如实记录差异。
3. **检查发布参数**：读取 @references/release.json。若 `package_version`、`aggregate_digest`、`npm_integrity` 仍为 `{{…}}` 占位，说明发布参数尚未回填：停止实际部署，向商家如实说明"云端接待的发布参数尚未就绪，暂时只能讲解流程"，并讲解下面各步骤。
4. 读取回填后的 release.json 三个值备用；npm 不可用（`npm --version` 失败）也如实停止。

## 首次开通流程（严格按序）

### 1. 取包并校验摘要

在会话工作目录执行（`<版本>` 取 release.json 的 `package_version`）：

```sh
mkdir -p kiwi-cloud-deploy-work
cd kiwi-cloud-deploy-work
npm pack @harrylabsj/kiwi-merchant-cloud@<版本>
tar -xzf harrylabsj-kiwi-merchant-cloud-<版本>.tgz
```

- npm 下载自带完整性校验；另执行 `npm view @harrylabsj/kiwi-merchant-cloud@<版本> dist.integrity` 取 registry 侧 sha512 integrity，与 release.json 的 `npm_integrity` 比对，不一致 → 停止（硬规则 5）。
- 读取解压出的 `package/build-manifest.json` 中的 `artifact_sha256`，与 release.json 的 `aggregate_digest` 比对，不一致 → 停止并报告两边的值。
- npm pack 失败（网络、版本未发布等）→ 贴报错原文并停止。**禁止**：`curl | sh`、拉取源码现场构建、在本地 `npm install` 现装依赖（本地与云端依赖不一致的风险）。

### 2. 首次发布：取得公网地址

- 调用 `workbuddy_sites_deploy` 做**第一次发布**（发布内容就用第 1 步的工作目录即可；这一次发布只为取得公网地址——prepare 需要 `--origin`，而地址只有发布后才知道）。
- 从回执记录**公网地址**（形如 `https://xxx.app.workbuddy.host`）与**应用标识**（applicationId/siteId 等，以回执实际字段为准），并贴给商家。
- 发布确认/费用弹窗由**商家本人**点击；配额/云服务不可用 → 按硬规则 4 停止。
- **回执失联保护（T009）**：发布报错导致拿不到地址或应用标识时，先与商家核对账号里是否已出现「Kiwi商家接待」，确认不存在后才允许再次创建，防止重复建应用。
- V1 遗留待确认点（如实向商家转述，不自行假设）：回执是否返回**稳定**的应用标识、能否**复用同一应用重新发布**（升级不换域名、状态目录保留）。回执不含稳定标识时，如实说明并请商家在平台面板核对后再继续。

### 3. prepare：生成部署目录

```sh
node package/prepare.mjs --origin <第 2 步公网地址> --out <部署目录绝对路径> --admin-bootstrap
```

- `--origin` 必须逐字符等于第 2 步回执的公网地址（prepare 自身会拒绝非 https / 带路径的 origin）。
- 可选：`--merchant-name <商家显示名>`（缺省写入占位名，工作台会提示商家补设）；`--catalog-url` 缺省即生产 Catalog 地址，不要改。
- 成功时 stdout 打印 JSON 回执（`deployment_dir`、`artifact_sha256`、`version` 等）；核对回执中的摘要与版本和 release.json 一致，不一致 → 停止。
- `--admin-bootstrap` 额外打印**一次性工作台首登口令**：立即按硬规则 7 展示这一次并提醒保存。

### 4. 同一应用再次发布

- 用 prepare 回执里的部署目录**绝对路径**再次调用 `workbuddy_sites_deploy`；必须复用第 2 步的**同一应用**（新建应用会导致域名变化，后续校验全部失效）。
- 失败 → 贴平台报错原文并停止（硬规则 6）。
- 成功 → 贴回执关键字段；核对公网地址与第 2 步一致，不一致 → 停止并如实报告。

### 5. 自检（对公网地址发 GET，用 Bash curl）

```sh
curl -sS -o /dev/null -w '%{http_code}\n' <origin>/livez
curl -sS <origin>/readyz
curl -sS <origin>/.well-known/agent-card.json
```

- `/livez` → HTTP 200。
- `/readyz` → HTTP 200 且 `ready:true`。注意：**尚未导入商品且未完成 Catalog 绑定时 products 检查不通过属预期**（D4：空商品起步、绑定前不报价）；此时服务已在运行，应引导商家先到工作台导入商品、再到 Catalog 授权，之后系统自动重试服务检查。其他检查（identity/storage/policy）失败 → 贴响应原文并停止。
- `/.well-known/agent-card.json` → HTTP 200 且 `url` 字段严格等于公网地址。
- 空闲回收后首个请求可能慢几秒，可稍候重试探测；仍失败 → 贴响应原文并停止，不谎报成功。

### 6. 引导商家完成两处本人确认

1. **工作台**：商家用一次性口令登录云端工作台（先导入商品），查看配对码（device enrollment）。你不读取、不转述配对码。
2. **Catalog**：商家打开 Catalog 授权页，核对两处配对码一致、公开预览无误，**亲自**点击「连接此服务并发布」。

### 7. 上线核对

- 调用 `kiwi_catalog_get_service_status`：`card.published` 且 `presence=fresh` 才宣布已上线（硬规则 9）。
- 工具不可用（连接器未提供）→ 如实说明无法自动核对，请商家在 Catalog 页面自查，不得宣称已上线。

## 升级流程（已有云端接待，换新固定版本）

1. 第 0 步检查同上（工具、回填后的新版本参数）。
2. 取新版本包并校验（同第 1 步）。
3. prepare：`--origin` 用商家现有公网地址（从上次部署记录或商家处取得；不确定时先自检现有地址 `/livez` 核对，仍不确定则与商家一起确认后再继续）。**不加 `--admin-bootstrap`**——状态目录已有工作台凭据时引导文件会被忽略，新口令不会生效；商家改口令在已登录的工作台内完成。
4. 用 prepare 的部署目录再次 `workbuddy_sites_deploy`，复用**同一应用** → 自检（同第 5 步）→ 用 `kiwi_catalog_get_service_status` 核对仍在线。
5. 向商家说明：同一应用重发布域名不变、状态目录（身份、账本、配对）保留；升级期间短暂不可用属正常。

## 暂停与恢复

- **暂停接待**（采购方搜不到名片）：优先在 Catalog/工作台暂停名片；实例保留，恢复时在 Catalog 重新发布名片。
- **平台应用下线**：会话内可用 `workbuddy_sites_unpublish` 下线；也可由商家本人在平台面板操作。如实告知两条路径与后果（下线后公网地址不可达），由商家决定。
- **恢复**：重新对同一应用调用 `workbuddy_sites_deploy`（部署目录不变时直接重发即可）。

## 方案 B 兜底（会话没有发布工具时）

第 0 步发现 `workbuddy_sites_deploy` 缺失时：

1. 不尝试变通；向商家说明"本会话缺少平台发布工具，改用方案 B：我把一段提示词给你，你在**普通 WorkBuddy 任务**里粘贴运行"。
2. 读取 @references/fallback-prompt.md，把整段提示词**原样**输出给商家；release.json 已回填时先将其中的 `{{PACKAGE_VERSION}}`、`{{AGGREGATE_DIGEST}}`、`{{NPM_INTEGRITY}}` 占位替换为回填值再输出。
3. 商家执行完毕回到本应用后，用「上线检查」路径（`kiwi_catalog_get_service_status`）核对最终状态。
4. 两条路的规则完全相同：不伪造、不代点、不输出凭据字段、口令只展示一次。

## 常见错误

1. 不核对账号里已有应用就再次创建 → 可能产生第二个「Kiwi商家接待」，域名与配对全部错位；发布回执丢失时必须先核对再创建。
2. 把平台回执里的凭据字段当普通字段贴出 → 半公开凭据，绝不输出。
3. 摘要不符时"重新下载试试" → 应立即停止上报，不换源不重试。
4. 发布失败后改 `cloud.config.json` 或删文件再试 → 禁止；原样上报。
5. 一次性口令展示后再次复述或写进总结 → 违反一次性原则。
6. 自检失败仍宣布上线 → 只有工具确认 `card.published && presence=fresh` 才能说已上线。
7. 承诺免费或 7×24 → 费用以平台弹窗为准；空闲回收后首个请求可能慢几秒。
8. 用 inspect/activate/deploy 的旧口径执行 → 该组工具在 Buddy 会话中**不存在**（V1 实测）；一律走 `workbuddy_sites_deploy`，工具对不上时如实报告并走方案 B。
