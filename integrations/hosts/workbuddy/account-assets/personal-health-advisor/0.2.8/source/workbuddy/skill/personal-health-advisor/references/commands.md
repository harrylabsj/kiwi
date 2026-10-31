# 命令参考

所有命令：`scripts/health-advisor [--mode live|demo] [--person <id>] <命令> ...`。stdout 为 JSON；错误为 stderr JSON `{"error","message","exit_code"}`。

| 命令 | 说明 | 关键选项 |
|---|---|---|
| `status` | 运行环境、档案路径、人物、口令来源（不含口令） | `--mode demo` 显示示例档案 |
| `auth init <口令文件>` | 创建新加密档案并保存口令副本 | `--person`、`--display-name` |
| `auth import <口令文件>` | 为已有档案导入口令 | `--vault <路径>` 记录档案位置 |
| `auth status` / `auth revoke` | 口令来源 / 删除本机口令副本 | — |
| `settings` | 查看设置 | — |
| `settings set` | 修改设置 | `--person`、`--display-name`、`--timezone`、`--vault`、`--bp-target 90-130/60-90`、`--goals-file <json>` |
| `record vital` | 血压/心率/体重 | `--at YYYY-MM-DDTHH:MM`、`--systolic`、`--diastolic`、`--heart-rate`、`--weight`、`--note`、`--input` |
| `record medication` | 实际服药事件 | `--at`、`--medication`、`--dose`、`--unit`、`--missed`、`--plan <计划id>`、`--note`、`--input` |
| `record activity` | 运动/冥想 | `--date`、`--type`、`--duration`（分钟）、`--distance`（km）、`--steps`、`--note`（计数如“共 60 个”）、`--input` |
| `record emotion` | 情绪 | `--at`、`--name`、`--duration`、`--feelings[-file]`、`--reflection[-file]`、`--input` |
| `record sleep` | 睡眠（`--date` 为起床日） | `--duration`（分钟）或 `--bedtime --wake-time`、`--quality 1-5`、`--note`、`--input` |
| `edit` | 按 ID 修改记录 | `--type vital|medication|activity|emotion|sleep`、`--id`、`--changes <json>` 或 `--changes-file` |
| `recent` | 近 N 天日常记录（写后核验） | `--days`（默认 7） |
| `trend` | 确定性趋势 | `--source vital|observation`、`--field`、`--start`、`--end` |
| `labs` | 已确认检验时间线 | `--field`、`--days` |
| `evidence <observation_id>` | 原始证据（报告行/页/文档） | — |
| `import <文件>` | 导入文本/PDF/图片到待核对区 | `--report-date`、`--display-name`、`--ocr-engine` |
| `candidates <job_id>` | 列出待核对字段 | — |
| `confirm <job_id>` | 逐字段确认写入正式记录 | `--field`（必填）、`--value`（必填）、`--unit`（单位换算时） |
| `assign <document_id>` | 确认待核对文档属于当前人物 | — |
| `encounters` / `plans` / `reminders` | 就诊与诊断原文 / 用药计划 / 提醒规则 | — |
| `visit-summary` | 就医摘要草稿 | `--start`、`--end`、`--output <md>` |
| `workbench <输出.html>` | 生成个人健康管理工作台（只读快照） | `--days 14|30|90` |
| `mcp` | 以 stdio MCP 服务运行：同名工具 + 内嵌实时工作台资源（由专家包的本地 MCP 配置启动，不需要手动运行） | — |
| `backup export <路径>` | 加密备份 | `--passphrase-file <独立口令文件>` |
| `backup import <备份>` | 恢复备份（会替换档案） | `--passphrase-file`、`--confirm RESTORE_VAULT`、`--replace` |

## 输入约定

- 时间用本地时间 `YYYY-MM-DDTHH:MM`；日期用 `YYYY-MM-DD`。
- `--input <json文件>` 的字段名与选项同名（连字符改下划线，如 `wake_time`）；命令行选项优先于文件内容；未知字段报错。
- 含引号、反引号、美元符或换行的长文本，用 `--feelings-file` / `--reflection-file` / `--input` 从本机文件读取。
- 计数型运动（俯卧撑、深蹲）把个数写进 `--note`，如“共 60 个”或“第一组 50 个，第二组 43 个”，工作台会汇总。
- 血压时段：中午前的测量记为晨间，中午后记为晚间。

## 退出码

`0` 成功 · `1` 其他错误 · `2` 参数或校验 · `3` 未配置或口令错误 · `4` 记录不存在 · `5` 需要显式确认（如恢复备份、文档未指定人物） · `6` 本机 Python 版本不满足或依赖安装失败。
