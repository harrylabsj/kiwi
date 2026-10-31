# 领域领航员｜WorkBuddy 专家

这是按 [WorkBuddy 官方专家包规范](https://open.workbuddy.cn/docs/expert) 制作的单专家包。模型由 WorkBuddy 提供，不需要单独的 OpenAI API Key。

包内有 `.codebuddy-plugin/plugin.json`、`agents/domain-navigator.md`、`skills/domain-learning/`（含 `skills/domain-learning/references/地图模板.md` 交付物模板）、`evaluations/cases.json`、`avatars/domain-navigator.png`。当前 WorkBuddy 5.5.6 的本地校验器尚未提供“教育学习”分类，因此此版本使用“行业顾问”分类；专家的市场文案和学习能力不受影响。分类一旦开放，改 `categoryId` 即可，校验脚本只会给出提示而不会阻断。

v0.2 定位是“两周限时建图 + 交付 AI 接口”：交付物是一份自包含的 Markdown 文件《⟨领域⟩地图 v⟨版本⟩》，同时充当给人读的地图、跨会话记忆载体和给其他 AI 的接口。每次会话结束都更新并交回这份文件；文件带回即续接。交付按“写文件并读回确认 → 生成可分享链接（可选增强，不作为依赖） → 输出完整 Markdown 全文”三级降级，全文输出是保底方式，必须始终可用。

专家开场白写在 `agents/domain-navigator.md` 的「开始」一节，由行为提示词驱动。`plugin.json` 的 `defaultInitPrompt` 是**用户侧**的首轮问句（与 `quickPrompts[0]` 逐字一致，现带具体领域和问题），两者角色不同，不要互相替代。若后续 WorkBuddy 开放独立的问候字段，再把开场白同步过去。

## 本地检查与打包

在项目根目录执行：

```sh
python3 scripts/verify_workbuddy_expert.py
python3 -m unittest discover -s tests -v
python3 scripts/build_workbuddy_expert.py
```

校验脚本区分 `ERROR`（阻断打包）和 `WARN`（提示，不阻断）。生成的 ZIP 位于 `outputs/domain-navigator-workbuddy-official.zip`，顶层直接是专家包文件；导入时选这个文件。

## 平台验收

在 WorkBuddy“专家·技能·连接器 → 专家市场 → 我的专家 → 创建专家”中导入或按当前界面要求创建，先保存为个人草稿。确认名称、分类、头像、简介和三个快捷问题显示正常，再召唤专家运行 `evaluations/cases.json` 中的 18 条用例，记录实际答复。平台操作说明以当时界面为准。

**当前状态**：ZIP 导入、卡片展示与真实对话均已在 WorkBuddy 5.5.6 验证通过（2026-09-17）。主进程日志里的 `wb:experts:get: Expert not found` 是加载旁路查询，不是阻断信号。被测的是客户端内已导入的 v0.1 包，**v0.2 需要重新导入**；18 条用例尚未逐条跑过，宿主文件写入能力未测，市场审核和公开发布均未进行。

本包不依赖、也不调用用户本机的任何命令行工具，交付物是标准 Markdown 文件，归档进 dbrain、Obsidian 等个人系统由用户自行完成。愿意用脚本写入个人 dbrain 的用户，可参考仓库 `references/optional-dbrain-bridge/`（可选参考实现，不随 ZIP 发布，需要本机已装 `dbrain` CLI）。

当前包没有声明必需的 MCP 或连接器，因此召唤时不应要求额外的第三方授权。
