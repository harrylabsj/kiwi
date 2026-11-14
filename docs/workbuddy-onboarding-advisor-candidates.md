# 开通顾问候选记录

## 0.1.5：审核已撤回，不可变

- 状态：审核已于 2026-11-12 19:40 在开放平台撤回（为提交 0.1.7）；本地源码保持原样，不新增、不修改文件。撤回后资产回落到线上已发布的 0.1.2。
- 逐文件 SHA-256：`integrations/hosts/workbuddy/kiwi-merchant-buddy/experts/kiwi-onboarding-advisor-0.1.5.sha256`（26 个文件）。
- 平台上传包哈希未回读，因此不在本仓声称与平台字节一致。

## 0.1.6：本地候选，尚未上传

- 来源：以 0.1.5 为基线复制并升版本为 `0.1.6`；随后仅做下列首次发布入口和内嵌技能标识相关改动。
- 内嵌技能标识升级为 `0.3.3`：这是 0.1.6 专家候选包内的副本标记，不创建独立 `0.3.3` 技能资产，也不声称 `0.3.3` 已独立发布；独立 `0.3.2` 候选与 0.1.5 内嵌 `0.3.2` 均保持原样。
- 新增固定首次发布取址入口 `skills/kiwi-cloud-deploy/first-publish/`：
  - `index.js`：无第三方依赖的 Node 启动入口；`/livez` 返回 200，`/readyz` 故意返回 503 且 `ready:false`，避免冒充正式运行时。
  - `package.json`：`private: true`，无 dependencies，不固定云端包版本。
  - `README.md`：说明只用于取得 `--origin`，第二次发布时由 prepare 产物覆盖。
- `skills/kiwi-cloud-deploy/SKILL.md` 首次发布步骤指向该固定目录；云端运行时版本仍只由 `scripts/cloud-session-cli.mjs stage` 对 npm `latest` 一次解析、锁定并验证。
- 未改动 latest 解析脚本、`test-only` 标记或 `executionAuthorized:false` 门；0.1.6 中这些脚本与 0.1.5 逐字节一致。
- 发布资产清单 `integrations/hosts/workbuddy/release-bundle-manifest.json` 已同时记录 0.1.5（审核中、不可变）与 0.1.6（本地候选、未上传）；资产构建器已将 `first-publish/` 纳入 ZIP allowlist。

0.1.6 是本地候选，不代表已上传、审核通过、发布或平台验收。

## 0.1.7：审核已撤回（被 0.1.8 取代）

- 来源：以 0.1.6 为基线复制并升版本为 `0.1.7`；改动面：`skills/kiwi-cloud-deploy/SKILL.md`（内嵌标识升到 `0.3.4`、补写升级流程）、新增 `skills/kiwi-cloud-deploy/scripts/upgrade-in-place.mjs`、`README.md`、`.codebuddy-plugin/plugin.json` 的版本/描述；其余文件与 0.1.6 逐字节一致。
- 内容来源：2026-11-12 一次真实原地升级（WorkBuddy 企业版既有云应用，`0.12.26` → `0.12.29`），应用 ID、域名、沙箱状态目录均保留，升级后 `livez=200`、`readyz` 四项全 ok。
- 写入「升级流程」的新增约束：
  - 只替换程序文件（`app/`、`contracts/`、`scripts/`、`index.js`、`package.json`、`build-manifest.json`、`package-lock.json`），逐字节保留 `cloud.config.json` 与 `pilot/merchant.yaml`；明确禁止把 `prepare.mjs` 整目录产物覆盖到发布目录（会换 `data_dir` 缺省 `/workspace/.kiwi-runtime` 与身份）。
  - 升级前备份发布目录；云模式无周期性备份任务（`runBackup` 只接在本地 CLI 运行时），不得假设平台已备份。
  - 平台无版本端点：`livez`/`readyz`/`agent-card` 均不返回版本号，须另有内容哈希或版本独有标记作为证据，否则只能说"版本未确认"。
  - 数据保留以 `readyz` 的 identity/storage/products 语义为准，不拿"域名没变"当证据；agent_id 连续性只能间接证明。
  - 升级包不在公共 npm registry 时必须如实标注来源。
- 新增 `scripts/upgrade-in-place.mjs`：整目录备份后只替换程序文件、逐字节保留 `cloud.config.json` 与 `pilot/merchant.yaml`，回执含前后版本/保留文件哈希/备份路径/未采用的配置差异；`--dry-run` 只报告。不解析 latest、不下载、不调用平台发布工具、不碰云端数据目录。
- `first-publish/` 入口、latest 解析与 `executionAuthorized:false` 门与 0.1.6 逐字节一致；未新增运行时依赖或凭据。
- 发布资产清单 `release-bundle-manifest.json` 增加 0.1.7；0.1.5 的观察状态更新为「审核已撤回」、0.1.6 条目不变。

## 0.1.7 的平台操作记录（2026-11-12）

- 19:40 撤回 0.1.5 的审核（平台提示「撤回后终止审批」）；撤回后资产回落到已发布的 0.1.2，应用本身未下线。
- 19:41 通过「更新版本」上传 `oe_eee5ab6349f00203-v0.1.7.zip`（57.3KB，构建自 `integrations/hosts/workbuddy/build-asset-zips.mjs`），平台解析出专家 ID `oe_eee5ab6349f00203`、版本号 `0.1.7`，介绍文案与包内一致。
- 19:41 提交审核成功，平台提示「预计 7 个工作日内出结果」；资产列表显示「审核中 · v0.1.7」。
- 0.1.2 仍是线上已发布版本；0.1.7 审核通过前不影响线上行为。上传包哈希以平台回执为准，本仓不声称与平台字节一致。

## 0.1.8：已提交审核（2026-11-12 21:46）

- 触发：腾讯云工单 202611126202（2026-11-12 21:15 答复，21:34 结单）给出的平台事实，以及我们对其中三条的实测修正。
- 写入技能 `0.3.5`：
  - 硬规则 11：发布目标由「本地目录 + 绑定标记」决定，工作区根目录 `.wbapp_<appId>.genie` 不得删除/搬移/改 `localDir`，否则新建应用和新域名。
  - 硬规则 12：发布后必须核对回执 appId，出现 `appId=<none>` 或新应用立即停止上报。
  - 升级流程第 8 步：数据目录随实例保留；平台无整包导出；云控制台导出不含实例内目录；禁止运行中拷 SQLite（WAL 一致性）；`/public/v1/updates/snapshot` 实测 422 不可用；拿不到「备份可恢复」证据前不升级。
- 实测修正（与工单口径不同）：发布目录**不需要** `package.json` 的 `"start": "node index.js"`——19:10 那次升级的目录里没有 start 脚本，发布仍成功并复用了原 appId。该条只作为报错时的排查项。
- 脚本、`first-publish/` 入口与 `executionAuthorized:false` 门与 0.1.7 逐字节一致。

- 平台操作：2026-11-12 21:44 撤回 0.1.7 审核（资产回落到已发布 0.1.2）；21:46 上传 `oe_eee5ab6349f00203-v0.1.8.zip`（57.8KB）并提交审核，列表显示「审核中 · v0.1.8」。

0.1.8 不代表审核通过、发布或平台验收。

## 0.1.9：本地候选，尚未上传（2026-11-14 整理）

- 来源：以 0.1.8 为基线复制并升版本为 `0.1.9`；内嵌技能标识升到 `0.3.6`（包内副本标记，不代表创建或发布独立 `0.3.6` 技能资产）。
- 改动面：
  - 执行授权：商家明确要求安装/升级即为本会话授权；`stage/verify` 在完整性、来源与安装副本校验通过后返回 `executionAuthorized:true`，不再依赖额外环境变量。该值不是平台签名，也不替代发布回执。
  - 升级不再依赖 `prepare`：已有应用直接用本次 session 的官方包根目录作为 `--staged`，只替换程序文件，逐字节保留 `cloud.config.json` 与 `pilot/merchant.yaml`。
  - 新增 `references/publish-params.json`（已验证的 node@22.19.0 安装/启动命令）与 `scripts/discover-target.mjs`（从 `.wbapp_*.genie` 读取 appId/localDir，相对路径按工作区根目录解析）。
  - `SKILL.md` 新增 `workbuddy_sites_deploy` 调用参数与回执核对，发布后自检 `/livez`、`/readyz`、`agent-card`。
  - 预检超时从 120 秒提升到 600 秒，避免冷缓存安装被误判为 `ISOLATED_INSTALL_FAILED`。
- 本次整理同时修正 0.1.9 内的过时文案：`references/fallback-prompt.md` 不再声明“方案 B 暂不可执行/executionAuthorized:false”；`first-publish/README.md` 不再引用已失效的预检门；首次发布的“V1 遗留待确认点”改为 2026-11-12 已实测的应用复用口径；移除误带的 `__pycache__`。
- 发布资产清单 `release-bundle-manifest.json` 增加 0.1.9（local candidate; not uploaded/reviewed）；0.1.8 保持提交审核状态不变。
- 0.1.9 不代表审核通过、发布或平台验收；上传、提交审核与真实安装/升级验收均未进行。
