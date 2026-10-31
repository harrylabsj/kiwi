---
name: personal-health-advisor
display_name: 个人健康管理顾问
description: 在用户电脑本地整理加密健康档案：记录血压、服药、运动、睡眠与情绪，逐字段核对检验报告，查看确定性趋势，生成个人健康管理工作台与就医摘要草稿；不依赖市场连接器或云端业务服务，不诊断、不处方。
description_zh: 在用户电脑本地整理加密健康档案：记录血压、服药、运动、睡眠与情绪，逐字段核对检验报告，查看确定性趋势，生成个人健康管理工作台与就医摘要草稿；不依赖市场连接器或云端业务服务，不诊断、不处方。
description_en: Keeps an encrypted personal health record on the user's own computer — daily vitals, medication events, exercise, sleep and mood, field-by-field lab confirmation, deterministic trends, a local health workbench and visit-summary drafts. No marketplace connector or cloud service; never diagnoses or prescribes.
version: 0.1.0
author: 北京海纳福星文化传媒有限公司
allowed-tools: Bash
---

# 个人健康管理顾问（免连接器 Skill）

在用户本机读写加密健康档案（Vault），并生成「个人健康管理工作台」。脚本通过 WorkBuddy 的本地 Bash 工具执行，需要用户电脑装有 **Python 3.11 或更新版本**；首次运行会创建私有环境并优先离线安装随包附带、带 SHA-256 锁定的 wheel。若本机系统或 Python 版本与随包 wheel 不兼容，脚本会尝试联网下载相同版本的依赖；失败时明确报错。

- 数据只保存在用户本机的加密档案里；工作台与备份不含口令。
- 所有数据更新都是显式命令；工作台是只读快照，页内操作只影响显示。
- 不要向用户索取、复述或输出档案口令；口令只能来自用户自己保存的本机文件。

## 一次性本机配置（仅一次）

1. 用户用系统文本编辑器把档案口令保存为一个本机文件（只有一行，至少 8 个字符），例如 `~/health-passphrase.txt`。**不要让用户把口令发到聊天里。**
2. 新档案：`scripts/health-advisor auth init ~/health-passphrase.txt --person me --display-name 用户称呼`；已有 healthCare 档案：`scripts/health-advisor auth import ~/health-passphrase.txt --vault /path/to/family.vault`。
3. 成功后提醒用户删除原始口令文件；口令副本以 0600 权限保存在数据目录，`auth revoke` 可移除，`auth status` 只显示来源，永不显示口令。
4. 已在环境变量里设置 `HEALTHCARE_PASSPHRASE` / `HEALTHCARE_VAULT` 的用户不需要这一步。

所有命令以本 Skill 包目录为工作目录执行：`scripts/health-advisor <命令> [选项]`。默认操作个人档案；加 `--mode demo` 使用完全独立的虚构示例档案（人物「林禾（示例）」）。默认提问明确请求示例时，先用 `health_open_workbench(mode=demo)` 展示，再解释本机建档；不要将示例称为用户自己的数据。

## 使用方式

stdout 始终是一个 JSON；错误写 stderr（JSON）并带退出码：`0` 成功 · `2` 参数或校验 · `3` 未配置或口令错误 · `4` 记录不存在 · `5` 需要显式确认 · `6` 本机 Python 不满足 · `1` 其他。

- “现在是什么状态”：`scripts/health-advisor status`
- “记一下今天早上血压 118/76”：`scripts/health-advisor record vital --at 2026-09-14T07:12 --systolic 118 --diastolic 76`，写完用 `recent --days 1` 核验并复述
- “早上的降压药吃了”：先 `plans` 取计划 ID，再 `record medication --at <时间> --medication <药名> --dose 0.5 --unit 片 --plan <id>`；用户明确说没吃用 `--missed`
- “今天做了 60 个俯卧撑 / 快走 3 公里 / 冥想 10 分钟”：`record activity --date <日期> --type 俯卧撑 --note "共 60 个"`（计数写在 note）/ `--type 快走 --distance 3 --duration 35` / `--type 冥想 --duration 10`
- “昨晚 23:20 睡、6:20 起”：`record sleep --date <起床日> --bedtime 23:20 --wake-time 06:20 --quality 4`
- “刚才紧张了 20 分钟”：`record emotion --at <时间> --name 紧张 --duration 20 --feelings "..." --reflection "..."`；长文本用 `--feelings-file` / `--reflection-file`，或所有字段用 `--input <json文件>`
- “最近两周血压怎么样”：`trend --source vital --field systolic_mmHg --start <日期>`，只复述返回的数据点、覆盖天数和 warnings
- “帮我整理这份报告”：`import <文件> --report-date <报告日期>` → 把返回的 `candidates` 逐字段列给用户（原值、单位、是否需要换算） → 用户逐项确认后 `confirm <job_id> --field <字段> --value <值> [--unit <规范单位>]`；**没有一次全部确认的命令**，未确认的字段不是健康事实
- “肌酐的历史值”：`labs --field creatinine`；要看原件用 `evidence <observation_id>`
- “打开/看看我的工作台”：先调用 `health_status`。若未建档，解释虚构演示与本机建档的选择；用户选择演示时调用 `health_open_workbench(mode=demo)`。已建档时调用 `health_open_workbench(mode=live)`，页面填写内容会回到对话，用户确认后再写入并核对。MCP 不可用时退回 `workbench ~/健康工作台.html [--days 14|30|90]` 生成只读快照并告诉用户文件位置
- “准备复诊资料”：`visit-summary --start <日期> --output ~/就医摘要.md`，提醒用户核对后再携带
- “改一下守线目标 / 医嘱血压区间”：`settings set --bp-target 90-130/60-90` 或 `--goals-file <json>`
- 备份：`backup export <路径> --passphrase-file <独立备份口令文件>`；恢复需 `backup import <备份> --passphrase-file <文件> --confirm RESTORE_VAULT`

## 内嵌实时工作台（本地 MCP）

专家包自带本地 stdio MCP 配置，启动的是同一个 `scripts/health-advisor mcp`，读写同一份档案、同一套口令规则。它提供状态、近期记录、趋势、检验、日常记录、候选与就医摘要工具，以及一个 `ui://` 资源：`health_open_workbench` 会在 WorkBuddy 里渲染实时工作台。工作台填写内容会通过 `ui/message` 回到对话，不会直接写入档案；候选逐字段确认只可通过本地 `confirm` 命令执行。

详细命令与选项见 [references/commands.md](references/commands.md)；口令与数据安全见 [references/security.md](references/security.md)；非诊疗边界与回答方式见 [references/boundaries.md](references/boundaries.md)。

## 行为边界

- **绝不删除或移动文件**：不要执行 `rm`、`mv`、`rmdir`、`find … -delete`、`python -m venv --clear`、`pip uninstall`、`--force-reinstall` 之类命令，也不要用 Python 删目录。引导脚本首次运行会在 `~/.cache/PersonalHealthAdvisor/` 建私有环境，全程不删文件；它以退出码 6 失败时，把 stderr 的 JSON 与 `install.log` 末尾原样报告给用户并停止，不要自行修复环境。

- **只读优先**：先用 `recent` / `labs` / `trend` 回答；需要写入时只记录用户明确陈述的实际事件，写后核验。
- **导入是候选**：`import` 的结果在用户逐字段确认前不是健康事实；回答时区分「已确认」与「待核对」。
- **不诊断、不处方、不调剂量**；不把未记录当作未服药或健康；提醒完成不等于实际服药。
- **数据不外发**：本 Skill 不调用远程模型；只有用户主动选中的内容才进入 WorkBuddy 模型任务。
- **单位敏感**：候选单位与档案规范单位不同时保持未映射，由用户给出换算后的值和规范单位，Skill 不静默换算。
