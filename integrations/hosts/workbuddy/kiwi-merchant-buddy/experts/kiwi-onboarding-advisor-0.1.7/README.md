# Kiwi 开通顾问

陪你走完注册、连接、一键上云、原地升级与上线检查，卡在哪一步就先解决哪一步。

本包用于 Kiwi 商家 Buddy 专用专家，依据 WP25 市场底稿生成。网关不访问商家实例；资料发布、费用和授权由商家本人确认。

首次发布取址入口固定在包内 `skills/kiwi-cloud-deploy/first-publish/`，只含启动脚本、无依赖的 `package.json` 和说明，不含商家数据或凭据。它只用于取得公网地址；云端运行时版本仍由 `cloud-session-cli.mjs stage` 对 npm `latest` 一次解析并验证，不在该目录固定版本。

包内嵌入技能标识为 `0.3.4`。这是本专家候选的内嵌副本标记，不代表已创建或发布独立 `0.3.4` 技能资产；独立 `0.3.2` 候选、0.1.5 内嵌 `0.3.2`、0.1.6 内嵌 `0.3.3` 均保持原样。

## 0.1.7 相对 0.1.6 的改动

新增 `skills/kiwi-cloud-deploy/scripts/upgrade-in-place.mjs`，并把 `skills/kiwi-cloud-deploy/SKILL.md` 的内嵌标识升到 `0.3.4`、补写升级流程。依据是 2026-11-12 一次真实原地升级（WorkBuddy 企业版既有应用，0.12.26 → 0.12.29）：

- 只替换程序文件（`app/`、`contracts/`、`scripts/`、`index.js`、`package.json`、`build-manifest.json`、`package-lock.json`），**逐字节保留** `cloud.config.json` 与 `pilot/merchant.yaml`；禁止把 `prepare.mjs` 整目录产物覆盖到发布目录（会换 `data_dir` 和身份）。
- 升级前必须备份发布目录；云模式**没有周期性备份任务**，不能假设平台已备份。
- 平台没有版本端点：`livez`/`readyz`/`agent-card` 都不返回版本号，必须另有内容哈希或版本独有标记作为证据。
- 数据保留以 `readyz` 的 identity/storage/products 语义为准，不拿"域名没变"作证据；商品与账本仍由商家本人核对。
- 升级包不在公共 npm registry 时必须如实标注来源。

新增 `skills/kiwi-cloud-deploy/scripts/upgrade-in-place.mjs`：原地升级的文件手术脚本，先整目录备份，只替换 `app/`、`contracts/`、`scripts/`、`index.js`、`package.json`、`build-manifest.json`、`package-lock.json`，逐字节保留 `cloud.config.json` 与 `pilot/merchant.yaml`，并在回执里报告替换前后版本、保留文件哈希、备份路径及「新版本配置与现网不一致但未采用」的字段。它是本地文件操作，不解析 latest、不下载、不调用平台发布工具、不碰云端数据目录、不读口令。

`first-publish/` 入口、latest 解析与 `executionAuthorized:false` 门均与 0.1.6 逐字节一致。
