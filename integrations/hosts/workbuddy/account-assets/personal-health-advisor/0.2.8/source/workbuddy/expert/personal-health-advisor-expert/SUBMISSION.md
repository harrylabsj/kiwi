# 个人健康管理顾问 · 提交前清单

候选物由项目根目录的 `python3 scripts/build_advisor_expert.py --zip` 生成：

- `dist/expert/personal-health-advisor-expert-0.2.8.zip`
- `dist/expert/personal-health-advisor-expert-0.2.8.zip.sha256`

提交前在 WorkBuddy 桌面端完成以下验证；不要使用真实档案、口令或报告录制公开案例。

1. 导入 ZIP，确认市场卡片显示「个人健康管理顾问」、行业顾问分类、3 个快捷提问和 512×512 头像。
2. 从空的用户目录启动最终 ZIP，确认专家自带 Node 20 MCP 启动器直接从包内找到 Python Skill，不依赖 `sh` 或曾运行 Skill 生成的 shim；再在真实 WorkBuddy 客户端首次召唤并连接该 MCP。没有 OAuth 或市场连接器引导。
2a. 使用默认提问，确认显示明确标识的虚构示例。随后打开尚未配置的个人档案，确认 `health_status` 返回建档引导而非工具错误；用户选择示例时，内嵌工作台可切换 14/30/90 天并刷新。完成本机建档后，再验证页面填写血压会先回到对话，明确确认后才由顾问写入并用 `health_recent` 核对。
3. 在一台装有 Python 3.11+ 的测试电脑上，用虚构口令文件验证 `auth init`、`auth status`、`auth revoke` 的提示；口令不得出现在对话、stdout 或 stderr 中。首次运行优先离线安装随包依赖，记录耗时与提示；平台不同导致离线 wheel 不兼容时，单独记录联网回退结果。
4. 用 `--mode demo` 验证「记录今天」「整理报告」「近 30 天血压」和 `workbench` 生成的 HTML：只显示虚构数据，打开时不产生外部网络请求（浏览器网络面板为空）。
5. 仅在用户主动授权后，用测试档案验证一次真实写入与核验：`record` → `recent`；`import` → 逐字段 `confirm` → `labs`；确认专家没有把候选当成事实，也没有提出用药调整。
6. 确认专家详情页与提示词没有承诺诊断、处方、云端同步、独立 Buddy 应用、OAuth 登录或公开分享用户健康数据。

作者公开联系邮箱沿用 `1711496337@qq.com`。提交审核、公开发布、上传灵感案例属于外部变更，需单独授权执行；本清单不构成发布完成声明。
