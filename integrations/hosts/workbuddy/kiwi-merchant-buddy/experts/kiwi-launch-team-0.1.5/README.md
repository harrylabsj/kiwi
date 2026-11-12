# Kiwi 开店团队

由 WP25 的五专家与团队底稿构建；平台调度与真实一键上云仍须预览验收。

## 0.1.5 相对 0.1.4 的改动

只同步内嵌的 `kiwi-cloud-deploy` 技能：`0.3.2` → `0.3.4`，与开通顾问 0.1.7 内嵌的技能逐字节一致。

- 新增 `skills/kiwi-cloud-deploy/first-publish/`：固定的首次发布取址入口（`index.js`、`package.json`、`README.md`），只用于取得公网地址，不固定云端版本、不含商家数据或凭据。
- 新增 `skills/kiwi-cloud-deploy/scripts/upgrade-in-place.mjs`：原地升级的文件手术脚本，先整目录备份，只替换 `app/`、`contracts/`、`scripts/`、`index.js`、`package.json`、`build-manifest.json`、`package-lock.json`，逐字节保留 `cloud.config.json` 与 `pilot/merchant.yaml`；`--dry-run` 只报告。
- `SKILL.md` 的升级流程改为实机验证过的原地升级步骤：禁止把 `prepare.mjs` 整目录产物覆盖到发布目录（会换 `data_dir` 与身份）、升级前必须备份（云模式无周期性备份任务）、平台无版本端点须用内容哈希或版本独有标记确认版本、数据保留以 `readyz` 的 identity/storage/products 语义为准。
- 五个 agent 提示词、其余两个技能（`kiwi-merchant-cs-prep`、`kiwi-product-import`）与 0.1.4 逐字节一致。
