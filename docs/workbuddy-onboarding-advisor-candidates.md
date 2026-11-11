# 开通顾问候选记录

## 0.1.5：审核中，不可变

- 状态：审核中（用户告知）；本地源码保持原样，不新增、不修改文件。
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
