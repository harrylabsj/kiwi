# 海纳·物流专家 / 物流运费对账专家 — 0.3.0

- WorkBuddy 资产：平台列表由本任务主代理于 2026-10-31 现场读取为已发布 `0.3.0`，ID `oe_8b7cbde9e305a91d`。这只是列表观察，平台未提供上传 ZIP 哈希。
- 精确来源候选：源码仓 `freight-reconciliation` 的 tag `v0.3.0`，commit `fcf282c6e0a804876527917fe4f75744e4213513`；该 tag 的 `pyproject.toml` 和 `scripts/build_host_package.py` 都声明 `0.3.0`，构建清单显示 WorkBuddy 专家名称和职称匹配。
- 来源仓没有该版 ZIP；tag 的确定性 builder 成功输出 55 个文件的 WorkBuddy 插件目录。随附 `freight-reconciliation-0.3.0-source-rebuild-candidate.zip` 是对该目录的新打包候选，不是原始平台上传 ZIP。其 SHA-256 写在对应 `.sha256` 中，未能与平台上传字节比对。
- 状态沿革：tag 内 `09_workbuddy_expert/README.md` 记载 2026-09-20 已以同一 ID 提交 `0.2.0`、当时审核中；本任务主代理在 2026-10-31 观察到该 ID 的当前列表版本 `0.3.0` 已发布。这是不同时间点的状态，不据旧记录否定当前列表，也不据当前版本推断旧 ZIP 字节。
- 来源快照仅含构建所需专家清单/技能、Core、MCP/管理适配器、契约、打包脚本、`pyproject.toml` 与 MIT `LICENSE`。未复制 tests、对账样例、数据库、账单、宿主实机验证记录或凭据。
- 在本资产目录运行 `python3 archive-tools/repack-built-candidate.py` 可从随附 `source/` 重建插件目录并生成候选 ZIP。该构建成功；ZIP 完整性校验通过。没有运行该应用的完整测试套件，也没有运行 CodeQL。
