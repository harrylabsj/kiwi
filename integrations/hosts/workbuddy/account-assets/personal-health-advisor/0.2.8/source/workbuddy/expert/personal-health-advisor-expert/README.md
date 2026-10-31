# 个人健康管理顾问 · 专家包源码

WorkBuddy 专家「个人健康管理顾问」的源码入口。发布形态为 **专家 + 内置本地 Skill + 用户自己的个人健康管理工作台**：专家负责对话引导与非诊疗边界，Skill（`personal-health-advisor`）在用户电脑本地读写加密档案、逐字段核对报告、生成只读工作台与就医摘要草稿。

专家包自带一份本地 stdio `.mcp.json`（启动同一个 Skill 引导器的 `mcp` 子命令），在支持 MCP Apps 的 WorkBuddy 里把工作台作为实时内嵌界面展示；不依赖市场连接器、Buddy 应用 OAuth 或任何云端服务，不包含用户档案、口令或原始报告。`skills/` 目录在构建时由 `python3 scripts/build_advisor_expert.py` 从 `dist/skill/personal-health-advisor/` 复制进来，不在源码中维护。

生成可上传的 ZIP：

```sh
python3 scripts/build_advisor_expert.py --zip
```

生成包仍需先在 WorkBuddy 客户端导入验收，再提交专家审核；不要将真实档案、工作台或口令放进公开市场或灵感案例。旧的 MCP 路径专家 `personal-health-management-expert/` 保留为 legacy，不随本包发布。
