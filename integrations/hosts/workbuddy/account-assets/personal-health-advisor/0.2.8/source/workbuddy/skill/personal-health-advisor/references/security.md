# 口令与数据安全

## 口令不落聊天、不落命令参数

- 唯一输入方式：用户自己保存的本机文件 + `auth init <文件>` / `auth import <文件>`；或用户自行设置环境变量 `HEALTHCARE_PASSPHRASE`。
- 解析顺序：环境变量 → 数据目录中的 0600 口令副本。副本损坏或权限不对时报错并要求重新 `auth import`，绝不回显内容。
- `auth status` 只显示是否已配置、来源和档案路径；任何命令的 stdout / stderr、备份、工作台、Skill 包都不含口令。
- 备份使用独立的备份口令文件（`--passphrase-file`），同样不进入输出。

## 数据位置与隔离

- 数据目录：macOS / Linux `~/.local/share/PersonalHealthAdvisor`，Windows `%LOCALAPPDATA%\PersonalHealthAdvisor`；可用 `HEALTH_ADVISOR_DATA_DIR` 覆盖。私有 Python 环境单独放在 `~/.cache/PersonalHealthAdvisor/venv-<版本>`（`HEALTH_ADVISOR_RUNTIME_DIR` 覆盖），随时可整目录删除重建。选 `~/.local` 与 `~/.cache` 是因为 WorkBuddy 的 Bash 沙箱只允许在少数目录里删除/改名文件，档案的原子保存（临时文件 + 改名）依赖这一点。
- 目录内：`family.vault`（个人加密档案，AES-GCM）、`family.vault.objects/`（原始报告密文）、`settings.json`、`passphrase`（0600）、`demo.vault`（示例）。
- 已有 healthCare 档案的用户可通过 `auth import --vault <路径>` 或 `HEALTHCARE_VAULT` 指向原档案，不需要迁移。
- 示例模式（`--mode demo`）使用完全独立的虚构档案，口令为常量、不含任何真实数据，每天按当前日期重建。

## 工作台与输出文件

- `workbench` 生成的 HTML 内联全部样式、脚本和数据，带 `default-src 'none'` 的 CSP，打开时不发起任何网络请求；文件权限 0600。
- 工作台、就医摘要、备份**包含个人健康内容**（不含口令），只在用户有意分享时才发给他人或模型任务。
- 输出路径不能覆盖档案、设置或口令文件。

## 内嵌实时工作台

- `mcp` 子命令只走 stdio，与 WorkBuddy 进程管道通信，不创建 HTTP 监听端口。首次安装运行依赖时优先使用包内 wheel；平台不兼容时可能访问 PyPI 下载相同版本，档案数据不会发送给 PyPI。
- 工作台页面通过 MCP Apps 的 postMessage 桥接取数；页面只从父级 WorkBuddy 窗口接收消息。完整界面数据还需要随 UI 资源下发、五分钟有效的随机能力令牌，普通 MCP 工具调用不能取得。页面填写记录会发回对话，不直接调用 MCP 写工具；候选确认仍需本地逐字段 `confirm` 命令。
- 页面上的快速填写不会直接写入档案：内容以一条「我确认记录：…」消息回到对话，由顾问调用记录工具写入并用近期记录核对；口令仍只来自本机文件或环境变量，MCP 配置里没有任何凭证。

## 信任边界

- 本 Skill 通过 WorkBuddy 本地 Bash 执行；每次写入都是一条可见命令，用户可在授权提示中看到值与单位。
- 报告候选的确认只有逐字段的 `confirm --field --value [--unit]`，没有一次全部确认的命令。
- 本 Skill 不调用远程模型、不发送邮件或消息、不创建系统提醒。
