# Kiwi 三仓受保护发布运行手册

本手册对应 `.github/workflows/portfolio-release.yml`。工作流默认是 dry-run；只有 `publish=true` 且通过 GitHub 受保护环境审批时，才会向 npm 与 PyPI 发布。

## 一次性外部配置

1. 在 `harrylabsj/kiwi` 创建 GitHub Environment：`kiwi-release`。
   - 配置至少一名 required reviewer。
   - 只允许受保护的 `main` 发布来源。
2. 在 npm 包 `@harrylabsj/kiwi` 配置 Trusted Publisher：
   - owner：`harrylabsj`
   - repository：`kiwi`
   - workflow：`.github/workflows/portfolio-release.yml`
   - environment：`kiwi-release`
3. 在 PyPI 项目 `kiwi-catalog` 和 `shopping-cli` 各配置同一组 GitHub Trusted Publisher 映射。
4. 确认仓库没有 `NPM_TOKEN`、`PYPI_TOKEN`、`TWINE_PASSWORD` 等长期凭据；发布使用短期 OIDC 身份。

## 发布前检查

- 为三个包分别 bump 到从未发布过的新版本；不能复用旧版本号。
- 更新对应的 `package-lock.json`、`uv.lock`，以及组合锁中需要变更的 consumer SHAs/contract source commit。
- `ref` 是本次 Kiwi bundle 的不可变中心源提交；`portfolio.lock.json.repositories.kiwi.commit` 只是组合快照锚点，不与 `ref` 做自引用比较（提交无法包含自身 hash）。
- catalog 与 shopping 的 commit、contract source commit、contract bundle SHA 必须保持 lock 一致，并由工作流从该中心 ref 检查。
- 先运行本地 `npm run verify`，并在两个 Python 仓运行 locked install、contract lock 和测试。

## 推荐执行顺序

### 1. Dry-run

在 Actions 中手动运行 **Portfolio protected release**：

- `publish=false`
- `ref` 可填分支名；为获得可复现证据，推荐填完整 40 位小写中心 commit SHA
- `verify_rollback=false`

该运行会固定检出两个消费者仓、执行三仓组合门禁、构建一次 release bundle、生成 SBOM、`SHA256SUMS`、release manifest、keyless cosign 签名和 provenance attestation，并上传 immutable artifact；不会访问发布接口。

### 2. 受保护发布

确认 dry-run 成功后重新手动运行：

- `publish=true`
- `ref` 必须是本次待发布中心源的完整 40 位小写 SHA；消费者仓和契约 commit 则由该 ref 内的组合锁固定

`publish` job 需要 `kiwi-release` reviewer 批准，然后只发布 build job 生成的 immutable bundle：npm 使用 provenance，PyPI 使用 Trusted Publishing。发布完成后 `verify-registry` 会重新下载 npm/PyPI 文件，按 release manifest 的 SHA-256（以及 npm SRI）逐一比对；任一不一致都 fail-closed。

## 回滚

回滚不是删除或 unpublish 包，而是把消费者重新指向已经验证过的上一版本 digest。

1. 将上一版本的 `release-manifest.json` 作为 HTTPS URL，或作为工作区内路径传入 `previous_manifest`。
2. 手动运行 workflow：`verify_rollback=true`，`publish=false`。
3. `rollback-verify` 只读校验上一版本 manifest 记录的 npm/PyPI artifact 是否仍匹配 registry digest，不执行删除、覆盖或重新发布。
4. 通过部署配置/消费者 lock 选择上一版本，完成服务回滚；恢复新版本时重新选择已验证的新版本 digest。

离线开发验证仍可使用：

- `scripts/rollback-drill.mjs`
- `scripts/verify-release-manifest.mjs`
- `scripts/verify-rollback-candidate.mjs`

## 当前未执行的外部动作

代码与工作流已完成并通过本地验收，但本地 GitHub CLI 授权当前无效，且无法从代码仓确认 `kiwi-release`、npm/PyPI Trusted Publisher 是否已由管理员配置。因此本轮没有执行真实 publish、registry download 或生产回滚；完成上述一次性配置后，应先 dry-run，再由 reviewer 批准 `publish=true`。
