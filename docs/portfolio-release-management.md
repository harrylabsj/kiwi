# Kiwi Portfolio Release Management

本文件定义 Kiwi 十一种产品形态的统一发布台账、制品来源、质量门与平台审批边界。版本号继续由各产品维护；`portfolio-products.json` 是产品清单，`portfolio.lock.json` 是三仓契约组合锁，`portfolio-release.yml` 是 npm/PyPI 与候选制品的中心构建入口。

## 产品台账

| 产品 ID | 当前版本来源 | 发布渠道 | 当前交付状态 | 主要门槛 |
| --- | --- | --- | --- | --- |
| `kiwi-merchant-cloud` | `packages/merchant-cloud/package.json` | npm，由受保护的 Portfolio workflow 发布 | 0.12.0 已由维护者手动首发（2026-09-29）；后续 OIDC 发布路径尚待实际验证 | cloud artifact/package 校验、签名、首发与 OIDC 配置 |
| `kiwi` | `package.json` | npm，由受保护的 Portfolio workflow 发布 | 0.12.0 已发布（2026-09-29）；registry 最新为 0.12.0 | `npm run verify`、签名与 `kiwi-release` 环境审批 |
| `kiwi-catalog` | `kiwi-catalog/pyproject.toml` | PyPI，由 Portfolio workflow 发布 | 0.5.2 已发布（2026-09-29）；registry 最新为 0.5.2 | 锁定测试、契约锁、签名与环境审批 |
| `shopping-cli` | `shopping-cli/pyproject.toml` | PyPI，由 Portfolio workflow 发布 | 源码 3.2.6；已发布（2026-09-29），registry 最新为 3.2.6 | 锁定测试、契约锁、签名与环境审批 |
| `kiwi-dsh-plugin` | `integrations/plugins/kiwi-dsh-plugin/package.json` | npm，由 Portfolio workflow 发布 | 0.1.2，已走 OIDC 发布（2026-09-29） | 插件校验、签名与环境审批 |
| `hermes-plugin-kiwi` | Hermes 仓库 `plugin.json` | GitHub 插件仓库 + Hermes 上游目录 | 仓库 tag v1.2.1；目录 pin 单独核对 | 固定仓库 SHA、插件校验、新会话冒烟、上游目录 PR |
| `kiwi-catalog-admin` | 私有仓库 `pyproject.toml` | 私有 Git tag，不发 PyPI | v0.2.0 已打 tag；生产部署待完成 | Catalog 0.5.x 兼容、Ruff/mypy/pytest、私有仓库 CI |
| `workbuddy-procurement-expert` | 专家包 `.codebuddy-plugin/plugin.json` | WorkBuddy 专家审核 | 本地候选 1.1.0；平台最近记录 v1.0.0 | 打包校验、WorkBuddy 预览和平台审核 |
| `workbuddy-merchant-app` | `buddy-app.config.json` | WorkBuddy App Builder | 本地草稿 1.8.0；没有平台应用 ID | 应用级授权/回调、预览和平台审核 |
| `workbuddy-merchant-connector` | `connector-meta.json` | WorkBuddy 连接器审核 | v1.2.0 七工具送审候选包，尚未上传 | 专用测试账号、OAuth/MCP 预览和平台审核 |
| `workbuddy-kiwi-sourcing-connector` | WorkBuddy 平台现有资产 | WorkBuddy 连接器更新 | v1.0.0，资产 `oc_bd73f860e3e2b5d3` 已发布；本地没有源包，runtime pin 仍记为 Kiwi 0.8.0 | 先恢复可维护源码，验证升级兼容后再申请平台更新 |

WorkBuddy 的状态依据本地平台核验记录，构建候选不代表已上传、审核通过或发布。Buddy 配置 JSON 是人工配置草稿，不是 WorkBuddy 官方导出文件。`kiwi-rfq-workbench` 是另一个尚未列入这十种产品的测试/工作台连接器，不随这份基线自动发布。

2026-09-29 组合发布落地：npm/PyPI 五个通道（Kiwi 0.12.0、merchant-cloud 0.12.0、DSH 插件 0.1.2、Catalog 0.5.2、shopping-cli 3.2.6）均已与各自 registry 对齐。其中 DSH 插件跳过 0.1.1 —— 该版本因 `package.json` 缺 `repository` 字段未通过 npm 的 sigstore provenance 校验（`422 Unprocessable Entity - Error verifying sigstore provenance bundle`），registry 未接受，故以 0.1.2 重新发布。新包走 OIDC 前，`package.json` 必须声明与 provenance 源仓库一致的 `repository.url`。

## 统一制品

每次 Portfolio dry-run 构建都生成一个有签名和 SHA-256 清单的 release bundle，并在 `portfolio-release-index.json` 中逐一登记十一种产品的版本、渠道、审批状态、制品路径与摘要。除 npm/PyPI 制品外还包含 `portfolio.lock.json`（固定 Kiwi / Catalog / shopping-cli / 契约来源）及：

- WorkBuddy 采购专家 ZIP；
- WorkBuddy 商家连接器 ZIP；
- WorkBuddy 商家 App 配置快照；
- 固定 SHA 的 Hermes 插件源码归档；
- Catalog Admin 私有仓库的版本与 commit 引用；
- 已发布但本地无源码的 Kiwi 采购询价连接器的平台版本和 runtime pin 状态；
- `portfolio-products.json` 产品版本和外部审批状态快照；
- 契约、SBOM、`SHA256SUMS` 与 `release-manifest.json`。

WorkBuddy 上传、审核、资产 ID 确认、Hermes 上游目录 PR，以及私有 admin 扩展 Git tag 是人工发布门。中心 workflow 构建 WorkBuddy 与 Hermes 可用候选，并为所有十一种形态生成签名索引；不会代替操作者提交平台审核。采购询价连接器源码不可用，因此只记录外部平台状态。Catalog Admin 私有源码不会复制到公共 workflow artifact，只记录固定 repo/commit/版本引用。`publish=true` 向 npm/PyPI 发布 Kiwi、merchant-cloud、DSH 插件、Catalog 和 shopping-cli，并且需要 `kiwi-release` 环境审批。

私有 `kiwi-catalog-admin` 因仓库权限不随公共 workflow checkout；台账固定记录其 repo、版本、commit 和依赖范围。生产安装必须使用已审阅的私有 tag，不能仅凭 `main` 分支浮动引用。

### merchant-cloud npm 首次发布（一次性人工步骤）

npm Trusted Publisher 配置只能在 package 已存在后添加。因此 `@harrylabsj/kiwi-merchant-cloud` 的首个版本需在 workflow dry-run 和审阅完成后，由东哥使用本人 npm 账号发布一次；不得把 npm token 放入仓库或 GitHub Secrets。步骤：

1. 确认 npm 账号已验证邮箱并开启 2FA；登录 [npmjs.com](https://www.npmjs.com/) 后，从受审阅的 `publish=false` release bundle 下载 `npm/kiwi-merchant-cloud/*.tgz`。
2. 用已登录的 npm CLI 发布这一个确切 tarball：`npm publish <下载的 .tgz 完整路径> --access public`。首发不传 `--provenance`，因为它由人工本地发布；之后版本全部走受保护的 OIDC job。确认 Registry 中出现 `@harrylabsj/kiwi-merchant-cloud@0.12.0` 后停止，不要再次发布同一版本。
3. 在 npmjs.com 打开 **Packages → @harrylabsj/kiwi-merchant-cloud → Settings → Trusted publishing → Add trusted publisher → GitHub Actions**，填写 Organization/user `harrylabsj`、Repository `kiwi`、Workflow filename `portfolio-release.yml`、Environment `kiwi-release`，并允许 `npm publish`。
4. 保存后核对 package 的 `repository.url` 是 `git+https://github.com/harrylabsj/kiwi.git`。`publish=true` 仍须另行通过 `kiwi-release` 保护环境审批；首发配置操作不会触发发布。

## 发布步骤

1. 在产品拥有的仓库更新版本源；每种产品独立 SemVer，不以同一个数字强行同步。同步 `portfolio-products.json` 中的版本、源仓 SHA、交付状态和证据日期。
2. 运行 `npm run verify:portfolio-products`，检查十一个产品条目、版本来源和 SHA 形状；构建后运行 `npm run verify:cloud-release-candidate` 验证 merchant-cloud 候选包。对 WorkBuddy 本地制品运行对应 `package-*.mjs --check`；Hermes 源归档必须与台账 SHA 相同。
3. Catalog 或 shopping-cli 有契约变动时，先用 `verify-portfolio-lock-candidate.mjs` 核对两个消费者的完整 commit SHA、契约来源 commit 和 bundle digest，再更新 `portfolio.lock.json`。该锁保持最近审阅过的组合，不自动跟随各仓 `main`。
4. 合并所有候选代码后，以中心 `main` commit 的完整 40 位 SHA 触发 Portfolio workflow，先用 `publish=false` 进行签名 dry-run，检查产品快照、所有制品哈希、契约锁、外部包版本与回滚清单。
5. 人工完成 WorkBuddy/ Hermes/私有 Git 渠道各自的发布审批，并把新资产 ID、版本、审核回执和时间写回台账。没有平台证据时只记为候选或待审核。
6. 只有 npm/PyPI 候选、契约组合和受保护环境审批都就绪后，才由授权发布者以同一完整 SHA 触发 `publish=true`。发布后核对 registry 下载、provenance、release manifest 和平台状态，再更新下一次 release 的版本矩阵。

## 发布边界

- 回滚只通过新版本，不重用已发布的 npm/PyPI 版本号。
- WorkBuddy App 或 Connector 的平台提交可能不可逆；平台状态变更需要用户明确授权和实机证据。
- `portfolio-products.json` 表示本仓记录的当前认知，不代替 npm/PyPI registry、WorkBuddy 后台、Hermes 目录或私有仓的实时核验。
- `kiwi-releases/` 中的历史 tarball 不是当前发布源；正式制品以受保护 workflow 生成的签名 bundle 为准。
