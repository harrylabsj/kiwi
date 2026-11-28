# Kiwi 开通顾问 0.1.9

0.1.9 起，这个专家可以真实安装和原地升级，不再是 test-only。

状态：本地升级验证已通过（2026-11-14，linkluck `0.12.29 → 0.12.30`，同应用发布，回执 `verified:true`，`/livez` 200，`/readyz` 四项 ok，身份文件逐字节保留）；待上传 WorkBuddy 开放平台审核。内嵌技能标识 `0.3.6`（专家包内副本标记，不代表已创建或发布独立 `0.3.6` 技能资产）。

## 相对 0.1.8 的变更

- **真实执行授权**：用户明确要求安装/升级即为本会话授权；`stage/verify` 在完成完整性、来源与安装副本校验后返回 `executionAuthorized:true`，不再依赖额外环境变量或平台预授权。
- **升级不依赖 prepare**：已有应用直接用本次 session 的官方包根目录作为 `--staged`，只替换程序文件，逐字节保留 `cloud.config.json` 与 `pilot/merchant.yaml`；避免 prepare 生成新身份/新 data_dir。
- **新增发布参数**：`references/publish-params.json` 固化已验证的 `node@22.19.0 → .node22 → npm ci → PORT 3000` 安装/启动命令。
- **新增目标发现**：`scripts/discover-target.mjs` 从工作区 `.wbapp_*.genie` 读取 `appId`/`localDir`，并读取 `cloud.config.json` 的 origin/data_dir。
- **真实发布步骤**：`SKILL.md` 新增 `workbuddy_sites_deploy` 调用参数与回执核对，发布后自检 `/livez`、`/readyz`、`agent-card`。
- **预检超时**：安装/检查超时从 120 秒提升到 600 秒，避免冷缓存安装被误判为 `ISOLATED_INSTALL_FAILED`。
- **npm 版本**：需要 npm >= 12.2.2；12.2.0 的 `npm audit signatures` 会漏掉顶层目标包，导致 `TARGET_NOT_VERIFIED`/`AUDIT_NOT_CLEAN`。
- **审计重试**：verify 遇到一次瞬时 attestation 读取失败会重试同一不可变 session，不换版本、不换 tarball。
- **保留边界**：不伪造回执、不代点费用/授权弹窗、不读取或转述配对码/口令/token；摘要/来源不符立即停止。

## 安全边界

- 只覆盖 `.wbapp_*.genie` 指向的同一应用；不新建替代应用。
- 只有用户明确要求安装/升级才设置授权；未授权不覆盖现网。
- 发布回执的 `appId` 和 `shareLink` 必须与目标应用一致，否则停止并上报。
