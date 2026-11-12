# 云端实例原地升级与平台边界（2026-11-12 核实）

本文记录一次**真实成功的原地升级**（Kiwi 商家接待云应用，0.12.26 → 0.12.29）的可复现步骤，以及腾讯云工单 202611126202 给出的平台事实与我们的实测修正。适用于「已有云应用要换版本，但必须保留应用 ID、域名和实例数据」的场景。

## 1. 结论先行

- 升级的可靠路径是：**不新建目录、原地替换程序文件、保留应用绑定标记，再对同一目录同一应用发布**。
- 平台发布工具按「这个目录属于哪个应用」的记录决定发布目标，**不是按 appId 参数指定**。
- 实例的数据目录跟随运行实例；只要不重新发布、不删除应用，它不会因为本地发布目录丢失而消失。
- 平台**没有**实例数据目录的整包导出能力，云控制台导出也不含实例内目录；**运行中直接拷 SQLite 会拿到 WAL 未合并的不一致副本**。

## 2. 平台事实（工单 202611126202，2026-11-12）

| # | 事实 | 我们的实测 |
| --- | --- | --- |
| 1 | 发布目标由本地目录决定；原目录/绑定标记丢失后，新目录发布会**新建**应用和新域名 | ✅ 一致 |
| 2 | 复用原应用的前提是恢复原发布目录及其**应用绑定标记** | ✅ 绑定标记就是工作区根目录的 `.wbapp_<appId>.genie`（记录 `appId` / `name` / `localDir` / `appType`） |
| 3 | 数据目录跟随实例，不重新发布就不消失 | ✅ 升级后 `readyz` 四项全 ok，商品检查通过 |
| 4 | 无整包导出；禁止运行中拷 SQLite（WAL） | ✅ 与 SQLite WAL 语义一致 |
| 5 | 云服务管理页的数据库/文件存储导出不含实例内目录 | ✅ 该应用云数据库为空表列表、`public.products` 报「表不存在」、文件存储只有 `users`/`shared` |
| 6 | 建议顺序：记录现状 → 只读导出业务数据 → 云侧导出 → 才发布 | 采纳 |
| 7 | 发布前判定：回执出现目标 appId 且指向已存在应用才继续；`appId=<none>` 立即中止 | 采纳，已写入开通顾问技能 |
| 8 | 发布目录需要 `package.json` 的 `"start": "node index.js"`，是 11-11 失败的直接原因 | ⚠️ **不成立（非通用前提）**：本次成功的发布目录里没有 `start` 脚本（只有 `prepare-cloud`/`preinstall`），发布仍复用原 appId。只作为报错排查项 |
| 9 | 可去掉凭据调用 `/public/v1/updates/snapshot` 导出业务数据 | ⚠️ **现网不可用**：完全不带 Authorization/Cookie 仍返回 422「公开 Feed 不接受凭据」，说明网关转发时注入了凭据头。不能当导出通道 |

## 3. 原地升级步骤（已实证）

```sh
# 0) 前置：确认应用仍在线且已发布；记录 appId、域名、当前版本
curl -s https://<实例域名>/livez   # 200
curl -s https://<实例域名>/readyz  # ready:true

# 1) 备份发布目录（唯一可靠的本地回退点）
cp -a <发布目录> <发布目录>-<日期>-backup

# 2) 只替换程序文件，逐字节保留 cloud.config.json 与 pilot/merchant.yaml
node <技能目录>/scripts/upgrade-in-place.mjs \
  --publish-dir <发布目录绝对路径> --staged <新版本包目录> --dry-run
node <技能目录>/scripts/upgrade-in-place.mjs \
  --publish-dir <发布目录绝对路径> --staged <新版本包目录>

# 3) 对同一目录、同一应用发布（不要动 .wbapp_<appId>.genie，不要改 localDir）
# 4) 核对发布回执：appId 必须是原应用，出现 <none>/新应用立即停止回滚
# 5) 核对线上：livez/readyz/agent-card，另用版本独有标记或部署内容哈希确认版本
```

要点：

- `prepare.mjs` 每次都会生成**新**的 `pilot/merchant.yaml`（新 agent_id）与**新** `cloud.config.json`（`data_dir` 缺省 `/workspace/.kiwi-runtime`）；**禁止把 prepare 产物整目录覆盖到发布目录**。
- 不要用 `--admin-bootstrap`：会重置既有工作台凭据。
- 平台没有版本端点，`livez`/`readyz`/`agent-card` 都不返回版本号，必须另找证据（部署回执内容哈希，或该版本独有的页面标记）。
- 升级窗口内实例会重启，可能短暂不可用。

## 4. 备份与恢复的现实边界

- 平台侧：无实例目录整包导出；云控制台导出只覆盖云侧资源。
- 应用侧：包内有周期 `backup` 任务与快照模块（`VACUUM INTO` + manifest + sha256），但**备份产物落在实例内部**，导出仍需应用侧入口；云模式没有默认调度备份。
- 因此「备份可恢复」这一前置条件，目前只能由平台快照或售后协助满足；拿不到证据前不要升级。

## 5. 相关位置

- 开通顾问技能：`integrations/hosts/workbuddy/kiwi-merchant-buddy/experts/kiwi-onboarding-advisor-0.1.8/skills/kiwi-cloud-deploy/SKILL.md`（硬规则 11/12、升级流程第 8 步）
- 商家侧升级指引：`docs/merchant-buddy/merchant-import-and-upgrade-guide.md`
