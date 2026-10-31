# 海纳·物流专家 — WorkBuddy 专家定稿（v0.2.0）

本目录是针对已实现 Core（src/freight_core + adapters）的专家资产定稿；`06_workbuddy_drafts/` 保持交接基线不动。
市场包由 `scripts/build_host_package.py` 构建到 `dist/host-plugin/freight-reconciliation/`。现已补齐头像、行业分类、展示文案和作者邮箱，且通过本机 WorkBuddy 专家包校验。2026-09-20 已向 WorkBuddy 开放平台提交 v0.2.0 审核，专家 ID `oe_8b7cbde9e305a91d`；平台状态为「审核中」，尚未公开发布。市场展示名「海纳·物流专家」，职称「物流运费对账专家」，展示分类「行业顾问」，服务类目「工具 - 办公」。客户试点与跨平台验证仍待完成；实机结果见 HOST-VERIFICATION.md。

```
09_workbuddy_expert/
├── expert/AGENT.md                     专家正文定稿
├── skills/freight-intake-and-rules/SKILL.md     导入与口径确认
├── skills/freight-reconcile-and-explain/SKILL.md 运行与差异解释
├── skills/freight-review-and-export/SKILL.md    补证复核与导出
├── connector/mcp-connector.json        本地 stdio 连接器声明草稿
└── HOST-VERIFICATION.md                WorkBuddy 实机验证清单（§18.2，初始 NOT_RUN）
```

首版路径（§18.2）：本地 Core → stdio MCP 连接器（adapters/mcp_server.py，14 工具）→ 一个专家依赖该连接器。
模型可 prepare 映射/规则/关联/复核/导出；人工确认只在本地管理页（adapters/admin_server.py）。
Buddy 应用封装后置（§18.3），需试点显示重复使用依据。
