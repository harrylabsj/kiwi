# npm 0.12.6 本地发布准备合同

状态：本地版本准备文档；不授予 push、publish、平台部署、WorkBuddy/Hermes 更新或真实业务验收权限。

## 版本范围

本候选统一准备以下两个 npm 包：

- `@harrylabsj/kiwi@0.12.6`
- `@harrylabsj/kiwi-merchant-cloud@0.12.6`

2026-10-21 的 registry 只读 metadata 未列出任一包的 `0.12.6`；正式执行前必须重新查询。两个包必须使用同一目标版本和同一 source commit。当前已发布 `0.12.5` 的 tarball、SRI、receipt 不能冒充新版本。

portfolio release workflow 仍有五个 publisher。本地合同只准备前两个包 bump；DSH plugin `0.1.2`、Catalog `0.5.6`、Shopping CLI `3.2.6` 保持各自当前版本，只有在受保护 workflow 中被证明为同版本幂等 skip 时才可继续。不得因 npm 版本升级修改外部 runtime pin、Hermes catalog pin、平台版本或未验证的部署事实。

## 源码适配范围

必须保持 root、merchant-cloud、独立 release stage 的 package metadata/lock 合同一致，并同步 shipping `VERSION`、candidate verifier、installed verifier、shipping contract tests、portfolio 两个 npm 产品版本和由 owner 生成的 SBOM。历史 `0.12.0` 工具合同、retry 依赖、外部 pin、历史归档和已发布包不做全局替换。

当前实现仍保持：owned 默认 `off`，显式 `require` 才启用；原有 SDK/lock、allowScripts、manifest guard、bin-link guard 和 package 完整性校验不放宽；`stopPermanently` 仍只有同进程嵌入 host 调用点。

## 本地构建顺序

在 clean 隔离 checkout 使用 Node 22.22.3/npm 12.2.0：

1. `npm ci --foreground-scripts`；
2. `npm run build`；
3. 使用 owner 入口 `node scripts/verify-facade-supply-chain.mjs --update-sbom` 更新实际 package/SBOM；
4. `node scripts/build-npm-shipping.mjs --freeze-source`，审核并提交 source contract；
5. `node scripts/verify-npm-shipping-source.mjs`；
6. root/stage/cloud pack、candidate verifier、双包正常 npm12 冷安装和 installed entry；
7. 保留每条命令的 exit code、stdout/stderr、tar SHA/SRI、manifest、audit、hooks 和 entry readback。

任何 source、lock、版本、manifest、工具链或包字节漂移都停止当前链；不得复用旧 receipt/tgz，不得使用 `--ignore-scripts`、dry-run 代替真实安装或全局 allow 绕过 hooks。

## 五通道与保护门

本地候选通过不等于 registry 发布。正式 workflow 必须先以完整 `RELEASE_SHA` 执行 `publish=false` dry-run，确认五个 publisher 的实际范围：前两个生成 `0.12.6` 候选，其余三个只对当前精确版本幂等 skip。若无法证明该范围，停止并单独审核 workflow，不改 hooks 或临时删 job。

只有取得明确的 push、protected `kiwi-release` 审批和 publish 授权后，才可运行 `publish=true`。本地不使用 npm token，不直接 `npm publish`，不触发平台部署。

## 一键上云与 WorkBuddy 对齐

现有技能资源仍可能引用历史 `0.12.0`，不能把本地版本修改或旧 manifest 写成新 registry 已发布。正式新包发布并完成 registry 只读核验后，另起候选：从同一个已核 SRI 的新 cloud tgz 提取 `build-manifest.json`、`prepare.mjs` 和 artifact 摘要，更新同版 `references/release.json`，运行技能/专家一致性检查。

资源回填与 npm 发布、WorkBuddy 更新、Hermes 更新、已有 app 部署分别交付；需要平台授权时使用既有 app/ origin/D 事实重新核验，不把历史 app 状态、私有 profile、真实账号或平台 pin 带入本地产品。未获平台授权不得上传、重送、撤回或覆盖在审资产。

## 完成定义

本地准备完成仅表示：两个包的 0.12.6 源码合同、SBOM、source contract、正式 pack、正常冷安装和实际入口均来自同一 clean commit，并经非作者复核。它不表示 npm 已发布、五通道已执行、WorkBuddy/Hermes 已更新、云端已部署或真实业务 E2E 已完成。
