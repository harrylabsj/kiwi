---
name: kiwi-cloud-deploy
display_name: Kiwi 云端接待部署
display_name_en: Kiwi Cloud Reception Deploy
description: Deploy the Kiwi merchant reception runtime to the merchant's own WorkBuddy cloud app in a strict order (inspect → activate → pack verify → prepare → deploy → self-check → Catalog publish) with no-forgery rules. Use for 一键开通云端接待、升级云端接待服务、云端接待部署排障；不用于自有服务器部署。
description_zh: 按固定顺序把 Kiwi 商家接待运行时部署到商家自己的云端应用，自检并引导上线确认。
description_en: Deploy the merchant reception runtime to the merchant's own cloud app step by step, self-check, and guide the go-live confirmation.
category: devops
version: 0.1.0
author: harrylabsj
---

# Kiwi 云端接待部署

本技能把 Kiwi 商家接待运行时部署到**商家自己账号名下**的云端应用，并引导商家完成上线确认。部署归属商家（平台只有会话内发布工具，没有远程代部署 API），全程以平台真实回执为准。

固定参数：云端应用 appName 一律用「**Kiwi商家接待**」。找到已有应用就复用，**绝不新建第二个同名应用**。

## 硬规则（先读，任何一步都不例外）

1. **不伪造回执**：每一步只汇报平台/命令真实返回；成功、失败原文照贴，不加工成"应该成功了"。
2. **不代点弹窗**：activate 等平台授权确认框由商家本人点击；技能只说明弹窗含义（费用/额度以弹窗显示为准），不催促、不代确认。
3. **publishableKey 不输出**：activate 回执里的 publishableKey 不贴出、不记录、不转述；只使用 applicationId、公网链接、resourceId、endpoint。
4. **配额不足立即停止**：回执出现 `cloud_service_unavailable` 或 `useLocalImplementation: true` 时，如实说明并停止；**不做任何本地兜底实现**，不代商家清理或升级配额。
5. **摘要不符停止**：npm integrity 或包内聚合摘要与 `references/release.json` 固定值不一致时，停止并如实报告两边的值；不换源、不换版本重试。
6. **deploy 失败贴原文**：失败原样上报，**不修改部署包内容重试**（尤其不许改 `cloud.config.json` 的 origin）；商家决定后续。
7. **一次性口令只展示一次**：prepare `--admin-bootstrap` 打印的工作台首登口令，立即展示这一次并提醒商家保存；此后不复述、不写进任何文件或总结。口令遗失无法找回，重新部署不会重置（状态目录已有凭据时引导文件被忽略）。
8. **不承诺免费或 7×24**：费用以平台弹窗为准；不说"永久在线"——空闲回收后首个请求可能有约 3 秒冷启动。
9. **上线判断只认工具**：只有 `kiwi_catalog_get_service_status` 显示 `card.published` 且 `presence=fresh` 才能说"已上线，采购方可以发现你并发来询价"；工具不可用或结果不符时如实说明卡点。
10. **不读取、不转述配对码**：Catalog 配对码由商家本人在工作台与授权页两处核对；配对码和链接都不是授权凭证。

## 第 0 步：执行前检查

1. **确认账号已连接**：先确认商家已连接 Kiwi 商家账号（有 `kiwi_catalog_get_merchant_profile` 时调用确认；没有则询问商家是否已连接，未连接先走注册开通，再回来部署）。
2. **检查会话工具**：确认本会话是否具备平台云发布工具——inspect（列出已注册应用）、activate（开通云端应用）、deploy（发布目录为在线应用）。**任一缺失 → 转入「方案 B 兜底」**，不要尝试变通。
3. **检查发布参数**：读取 @references/release.json。若 `package_version`、`aggregate_digest`、`npm_integrity` 仍为 `{{…}}` 占位，说明发布参数尚未回填：停止实际部署，向商家如实说明"云端接待的发布参数尚未就绪，暂时只能讲解流程"，并讲解下面各步骤。
4. 读取回填后的 release.json 三个值备用；npm 不可用（`npm --version` 失败）也如实停止。

## 首次开通流程（严格按序）

### 1. inspect：查找已有应用

- 调用 inspect 列出当前账号已注册的应用，按 appName「Kiwi商家接待」精确匹配。
- **恰好一个**：记录 applicationId 与公网链接，第 2 步用 reuse。
- **没有**：第 2 步用 create。
- **多个同名**：停止，如实列出并请商家确认用哪一个；绝不擅自选择或新建。
- 把与该应用相关的 inspect 结果贴给商家（applicationId、公网链接；不含 publishableKey）。

### 2. activate：开通/复用云端应用

- 没有时 `applicationMode=create`、appName「Kiwi商家接待」；有时 `applicationMode=reuse` + 该 applicationId。
- **不勾选任何云端模块**（数据库/登录/存储/LLM 都不勾）。若平台强制至少勾选一项，停止并如实说明，让商家选择，不擅自替选。
- 平台弹出的授权确认框由**商家本人**点击；你只解释弹窗内容。
- **回执失联保护（T009）**：activate 报错导致拿不到 applicationId 时，回到第 1 步重新 inspect 查找，确认不存在后才允许再次 create，防止重复建应用。
- 配额不足（`cloud_service_unavailable` / `useLocalImplementation:true`）→ 按硬规则 4 停止。
- 记录并贴出：applicationId（原样）、公网链接（形如 `https://xxx.app.workbuddy.host`）、publicConfig 中的 resourceId 与 endpoint。

### 3. 取包并校验摘要

在会话工作目录执行（`<版本>` 取 release.json 的 `package_version`）：

```sh
mkdir -p kiwi-cloud-deploy-work
cd kiwi-cloud-deploy-work
npm pack @harrylabsj/kiwi-merchant-cloud@<版本>
tar -xzf harrylabsj-kiwi-merchant-cloud-<版本>.tgz
```

- npm 下载自带完整性校验；另执行 `npm view @harrylabsj/kiwi-merchant-cloud@<版本> dist.integrity` 取 registry 侧 sha512 integrity，与 release.json 的 `npm_integrity` 比对，不一致 → 停止（硬规则 5）。
- 读取解压出的 `package/build-manifest.json` 中的聚合摘要，与 release.json 的 `aggregate_digest` 比对，不一致 → 停止并报告两边的值。
- npm pack 失败（网络、版本未发布等）→ 贴报错原文并停止。**禁止**：`curl | sh`、拉取源码现场构建、在本地 `npm install` 现装依赖（本地与云端依赖不一致的风险）。

### 4. prepare：生成部署目录

```sh
node package/prepare.mjs --origin <第 2 步公网链接> --out <部署目录绝对路径> --admin-bootstrap
```

- `--origin` 必须逐字符等于 activate 回执的公网链接（prepare 自身会拒绝非 https / 带路径的 origin）。
- 成功时 stdout 打印 JSON 回执（部署目录、聚合摘要、版本）；核对回执中的摘要与版本和 release.json 一致，不一致 → 停止。
- `--admin-bootstrap` 额外打印**一次性工作台首登口令**：立即按硬规则 7 展示这一次并提醒保存。

### 5. deploy：发布为在线应用

- 用 prepare 回执里的部署目录**绝对路径**调用 deploy；applicationId 必须复用第 1/2 步记录的同一个（新建应用会导致域名变化，后续校验全部失效）。
- 失败 → 贴平台报错原文并停止（硬规则 6）。
- 成功 → 贴回执关键字段（deployedAs、sandboxId、verified）；核对公网链接与第 2 步一致，不一致 → 停止并如实报告。

### 6. 自检（对公网链接发 GET）

```sh
curl -sS -o /dev/null -w '%{http_code}\n' <origin>/livez
curl -sS <origin>/readyz
curl -sS <origin>/.well-known/agent-card.json
```

- `/livez` → HTTP 200。
- `/readyz` → HTTP 200 且 `ready:true`，identity/storage/products/policy 四项全过。
- `/.well-known/agent-card.json` → HTTP 200 且 `url` 字段严格等于公网链接。
- 空闲回收后首个请求可能慢几秒，可稍候重试探测；仍失败 → 贴响应原文并停止，不谎报成功。

### 7. 引导商家完成两处本人确认

1. **工作台**：商家用一次性口令登录云端工作台，查看配对码（device enrollment）。你不读取、不转述配对码。
2. **Catalog**：商家打开 Catalog 授权页，核对两处配对码一致、公开预览无误，**亲自**点击「连接此服务并发布」。

### 8. 上线核对

- 调用 `kiwi_catalog_get_service_status`：`card.published` 且 `presence=fresh` 才宣布已上线（硬规则 9）。
- 工具不可用（连接器未提供）→ 如实说明无法自动核对，请商家在 Catalog 页面自查，不得宣称已上线。

## 升级流程（已有云端接待，换新固定版本）

1. 第 0 步检查同上（工具、回填后的新版本参数）。
2. inspect 找到「Kiwi商家接待」→ 复用其 applicationId（找不到时按首次开通处理，先和商家确认）。
3. 取新版本包并校验（同第 3 步）。
4. prepare：**不加 `--admin-bootstrap`**——状态目录已有工作台凭据时引导文件会被忽略，新口令不会生效；商家改口令在已登录的工作台内完成。
5. deploy 复用同一 applicationId → 自检（同第 6 步）→ 用 `kiwi_catalog_get_service_status` 核对仍在线。
6. 向商家说明：同 ID 重部署域名不变、状态目录（身份、账本、配对）保留；升级期间短暂不可用属正常。

## 暂停与恢复

- **暂停接待**（采购方搜不到名片）：优先在 Catalog/工作台暂停名片；实例保留，恢复时在 Catalog 重新发布名片。
- **平台应用下线/删除**：只能商家本人在「设置 → 数据管理 → 应用」面板操作（平台为面板专属能力，会话工具无法代办）；如实告知路径，不代替操作。

## 方案 B 兜底（会话没有云发布工具时）

V1 尚未验证：Buddy 会话能否调用 inspect/activate/deploy 未实测。第 0 步发现任一工具缺失时：

1. 不尝试变通；向商家说明"本会话缺少平台云发布工具（V1 未验证），改用方案 B：我把一段提示词给你，你在**普通 WorkBuddy 任务**里粘贴运行"。
2. 读取 @references/fallback-prompt.md，把整段提示词**原样**输出给商家；release.json 已回填时先替换其中的 `{{PACKAGE_VERSION}}`、`{{AGGREGATE_DIGEST}}`、`{{NPM_INTEGRITY}}` 占位，未回填时说明需等待发布参数。
3. 商家执行完毕回到本应用后，用「上线检查」路径（`kiwi_catalog_get_service_status`）核对最终状态。
4. 两条路的规则完全相同：不伪造、不代点、不输出 publishableKey、口令只展示一次。

## 常见错误

1. 跳过 inspect 直接 create → 可能产生第二个同名应用，域名与配对全部错位；activate 回执丢失时必须先查再建。
2. 把 publishableKey 当普通字段贴出 → 它是半公开凭据，绝不输出。
3. 摘要不符时"重新下载试试" → 应立即停止上报，不换源不重试。
4. deploy 失败后改 `cloud.config.json` 或删文件再试 → 禁止；原样上报。
5. 一次性口令展示后再次复述或写进总结 → 违反一次性原则。
6. 自检失败仍宣布上线 → 只有工具确认 `card.published && presence=fresh` 才能说已上线。
7. 承诺免费或 7×24 → 费用以平台弹窗为准；空闲回收后首个请求可能慢几秒。
