# 双来源搜索发布计划（工作包 D）

版本：v0.1（2026-09-26）
依据：设计文档 v1.1 §18（版本与交付链路）；`docs/releasing.md`；`docs/kiwi-protected-release-runbook-2026-08-09.md`；验收记录见 `docs/dual-source-search-acceptance-runbook.md`
状态：**计划，未执行**。本文只列步骤、命令、审批门与回滚点，任何 `publish=true`、push、平台提交都必须逐条取得你的明确授权。

---

## 0. 发布拓扑与现状（事实）

| 事实 | 值 | 来源 |
| --- | --- | --- |
| 唯一发布通道 | `.github/workflows/portfolio-release.yml`（manual / serialized / `kiwi-release` 受保护环境 + 人工审批） | workflow 头注释、`docs/releasing.md` |
| 发布输入 | `publish`（默认 false=dry-run）、`ref`（`publish=true` 时**必须是 40 位完整 SHA**） | workflow `inputs` |
| 凭据形态 | npm / PyPI Trusted Publisher（仓库不存任何 token）；`gh` 本机已登录 `harrylabsj`（repo scope） | workflow 头注释；`gh auth status` |
| 版本现状 | 仓库 `0.11.0`（未发布）；npm latest `0.10.0`；Hermes 插件与 WorkBuddy 连接器 pin `0.8.0` | `package.json`；`npm view`；两端 mcp.json |
| 本次改动范围 | 只有 `@harrylabsj/kiwi`（含两端技能/专家包）；`kiwi-catalog`、`shopping-cli` **未改** | 本次提交列表 |
| 组合锁 | `portfolio.lock.json` 的 `repositories.kiwi.commit = a034738…`，是当前 HEAD 的祖先（落后）| 本机核对 |
| 分支 | `merchant_cloud_workbuddy` 领先 `main` 7 个提交；`main` 无领先提交（可 fast-forward） | `git log` |
| 上游插件目录 | `~/.hermes/hermes-agent` 是 `NousResearch/hermes-agent` 的检出（另有 `harrylabsj/hermes-agent-fork` fork remote） | `git remote -v` |

---

## 1. 已拍板的决策（2026-09-26）

| # | 决策 | 结论 |
| --- | --- | --- |
| 1 | 版本号 | **直接发 0.11.0**（仓库现值；0.11.0 从未发布，不构成版本复用，无需改任何版本文件） |
| 2 | 合并方式 | **fast-forward 到 main**（已本地完成，见下；未推送） |
| 3 | 连接器是否同期 republish | **先不发，单独一批**（连接器无仓库源码、打包形状未验证、影响全部已装用户） |

### 已完成的本地动作（未推送、未触发任何外部动作）

- `main` 已 fast-forward 到 `5761974`（本次工作 7 个提交之内），相对 `origin/main` 领先 174 个提交且**包含**其全部提交 → 推送将是干净快进。
- `portfolio.lock.json` 的 kiwi 锚点曾按 `5761974` 试改并还原（见下方预检发现，锚点一行命令即可重设）。

### 预检发现：consumer 侧工作区漂移（**发布前需你定夺**）

`node scripts/verify-portfolio-lock-candidate.mjs` 失败，原因是本地 consumer 检出与组合锁不一致——**与本次改动无关，是既有漂移**：

| Consumer | 本地 HEAD | 锁钉 SHA | 关系 |
| --- | --- | --- | --- |
| `kiwi-catalog` | `ab76290` | `f2e6de6` | 本地领先 1 个提交；该仓另有 **25 个未推送提交**（含 `kiwi-catalog 0.3.0 → 0.4.0` 版本 bump）；锁钉 SHA 只存在于远端分支 `origin/merchant_cloud_workbuddy` |
| `shopping-cli` | `69dfc17`（= `origin/main`） | `d0d345d4` | 锁钉 SHA 在 `origin/main` 上（已推送），本地领先它 |

**影响**：发布 workflow 是按锁里的 SHA 从 GitHub 检出（`actions/checkout` + `ref`），上述两个 SHA 在远端均可达 → **发布本身不会被卡住**；失败的只是本地预检（它要求本地检出与锁一致）。

**两条路（需你选）**：

- (a) **临时对齐本地检出**：把两个 consumer 检出切到锁钉的 SHA（`git checkout <sha>`，分离头，不动分支、不丢提交），预检即过；发完再切回。
- (b) **重锚 consumer**：按「consumer 钉最新已推送 HEAD」把 `kiwi-catalog` 指向 `9673629`、`shopping-cli` 指向 `69dfc17`。注意：这会改变发布 bundle 里 consumer 的代码状态，且 catalog 那 25 个未推送提交要先有自己的归宿。

---

## 2. 分步清单

### D1 合并与推送（外部可见，**需你授权**）

```sh
cd ~/coding/kiwi
git checkout main && git merge --ff-only merchant_cloud_workbuddy
git push origin main            # ← 对外可见，需授权
```

- **期望**：`main` 前进到本次 HEAD；CI（ci.yml / portfolio-contracts.yml）绿。
- **回滚**：`git reset --hard <原 main SHA>` 并 force-push（破坏性，需再次授权）；未推送时 `git checkout main && git reset --hard <原 SHA>` 即可。
- 同批：`~/coding/hermes-plugin-kiwi` 的 `feat/dual-source-search` 合入其 `main`（**先不合**，等 D5 与 pin 升级一起做，避免中间态）。

### D2 版本与组合锁（本地、可逆）

1. 若选 0.11.0：**不改版本号**，仅确认 `package.json` / `src/product-cli.ts` 一致（`PRODUCT_VERSION` 读自 package.json，本就一致）。
2. 重锚 `portfolio.lock.json`：`repositories.kiwi.commit` → `main` 的新 40 位 SHA（其余条目不动）。
3. 预检：
   ```sh
   node scripts/verify-portfolio-lock-candidate.mjs --lock portfolio.lock.json \
     --kiwi-catalog-dir ~/coding/kiwi-catalog --shopping-cli-dir ~/coding/shopping-cli
   ```
   该脚本校验两个 consumer checkout 与锁一致、合同 bundle 哈希一致；**只读、无网络**。
4. 提交并推送（推送需授权）。

- **回滚**：`git revert` 该提交即可（lock 只是声明，无副作用）。

### D3 Dry-run（无副作用，可随时重跑）

```sh
gh workflow run portfolio-release.yml -f publish=false -f ref=main
gh run watch $(gh run list --workflow=portfolio-release.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

- **期望**：`build-once` 通过——完整 verify、构建三个包、SBOM、`SHA256SUMS`、manifest、cosign 签名与构建溯源；**不触碰任何 registry**。
- **回滚**：无需（无副作用）。

### D4 受保护发布（**不可逆**，审批门）

```sh
gh workflow run portfolio-release.yml -f publish=true -f ref=<D1 后的 40 位 SHA>
```

然后在 GitHub 上**由你本人**审批 `kiwi-release` 环境（可能出现多个 publish 任务，逐个审批）：
`https://github.com/harrylabsj/kiwi/actions`

- **期望**：npm 上 `@harrylabsj/kiwi@0.11.0` 出现（`--provenance`）；`kiwi-catalog` / `shopping-cli` 版本未变 → **幂等跳过**；`verify-registry` 重新下载校验通过。
- **回滚**：**没有回滚**。npm 已发布版本不可删除（只能 `deprecate`）；如需纠正，只能发新的 patch 版本。因此 D4 之前 D1–D3 必须全绿。
- 全部绿后：`git tag v0.11.0 <SHA> && git push origin v0.11.0`（打 tag，需授权）。

### D5 Hermes 插件（发布成功后）

1. 插件仓：`git checkout main && git merge --ff-only feat/dual-source-search`。
2. `mcp.json`：`@harrylabsj/kiwi@0.8.0` → `@harrylabsj/kiwi@0.11.0`；`plugin.json` 已是 `1.2.0`。
3. 本地验证：按 runbook §2 重装/重启用插件（`hermes plugins disable/enable kiwi`），跑一次只读搜索确认新版本生效。
4. 推送插件仓（需授权）。
5. **插件目录条目**：`plugin-catalog/kiwi.yaml` 在 `NousResearch/hermes-agent` 上游——把 `sha` 指向插件仓新 HEAD、`version` 指向 `1.2.0`，走上游 PR（经 `harrylabsj/hermes-agent-fork`）。这是**对外动作**，需要你确认由谁提交、以什么身份提交。
6. 同时更新 `~/.hermes/plugins/kiwi` 的测试参数（去掉本地 dist 指向）或直接 `hermes plugins remove kiwi` 后按目录安装。

- **回滚**：插件仓 revert + 重新指向旧 SHA；已安装用户用 `hermes plugins update`/`remove`。目录条目未合入前不影响任何人。

### D6 WorkBuddy 专家包 v1.1.0（平台提交，需你在开放平台操作）

1. 从合并后的 `main` 重建 ZIP：`node integrations/hosts/workbuddy/package.mjs --out <path>/kiwi-procurement-expert-1.1.0.zip`。
2. 开放平台「更新版本」→ 上传 ZIP → 提交审核（asset 与依赖 source 不变：`kiwi-procurement-expert` / `kiwi-sourcing`）。
3. 审核通过后，本机安装副本升级（或者：本地预览已装 1.1.0，重启客户端即可）。

- **回滚**：审核通过前无影响；通过后若发现问题，重新提交修正版本（平台保留历史版本）。

### D7 WorkBuddy 买方连接器 republish（**最高不确定度，建议单独一批**）

现状：连接器**在本仓无源码**，本机只有已安装副本 `~/.workbuddy/connectors-marketplace/connectors/kiwi-sourcing/`（v1.0.0，pin 0.8.0）。本次只需要把 `mcp.json` 的 pin 改为 `0.11.0`，但打包形状/平台校验未经验证。

建议顺序：local 复制安装副本 → 改 pin → 打成 ZIP（先不提交）→ 在平台「更新版本」页面**只做校验性试传**（不点最终提交）→ 确认通过后再正式提交审核。

- **风险**：平台可能拒绝非官方工具链产出的包；连接器上线会改变**所有已装用户**的运行时（比专家包影响面大）。
- **回滚**：未过审无影响；过审后若异常，按平台流程回退到上一版本（v1.0.0 保留）。

### D8 发布后复核与记录

1. `gh run view <id>` 确认 `verify-registry` 绿；npm/PyPI 上版本号与 provenance 可见。
2. 两端实机复核（可选，桌面面板走 runbook §3 的 5 条提示；Hermes 会话确认新版本 pin 生效）。
3. 在 `docs/dual-source-search-acceptance-runbook.md` 追加发布记录（版本、SHA、tag、平台审核结果）。

---

## 3. 审批门清单（**必须你本人操作**）

| # | 门 | 形式 |
| --- | --- | --- |
| 1 | 推送 `main`（kiwi / 插件仓） | 你的授权（我不代推） |
| 2 | `publish=true` 后 `kiwi-release` 环境审批 | GitHub 环境审批链接（你点） |
| 3 | WorkBuddy 开放平台提交/发布（专家包、连接器） | 你的账号操作 |
| 4 | `NousResearch/hermes-agent` 插件目录 PR | 你的 GitHub 身份 |
| 5 | 打 tag 并推送 | 你的授权 |

## 4. 主要风险

1. **D4 不可逆**：npm 已发布版本不能删；版本号只能前进。
2. **D7 不确定度最高**：连接器无源码、打包形状未验证、影响面覆盖全部已装用户 → 已建议单独一批。
3. **上游目录 PR 的外部依赖**：审核时间不可控；未合入前线上用户仍用 0.8.0。
4. **幂等跳过会掩盖版本复用**：本次只有 kiwi 变版本，catalog/shopping-cli 会跳过——如果 dry-run 日志里出现「跳过」的包**版本号却是新的**，那是异常信号，需停下排查。
5. **验收侧遗留**：桌面端专家面板的新鲜会话未实操；面板级确认建议在 D6 之后补做。

## 5. 可以立刻做而不触发任何外部动作的部分

- D2 的 lock 重锚草稿 + `verify-portfolio-lock-candidate.mjs` 预检（本地只读）。
- D3 的 dry-run 命令演练（**触发 workflow 即对外可见**，需你点头）。
- D5 的插件仓合并与 pin 改动（本地，不推）。
- D6 的 ZIP 重建与校验（本地）。
