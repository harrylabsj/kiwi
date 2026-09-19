# Kiwi 询报价工作台 · 私有宿主接入（M4）

工具与技能的实现状态已随 M0–M3 落库（RFQ-012 完成：14 个工具已在 `src/mcp/merchant-rfq-tools.ts` 注册，`tools.json` 为同面契约）。本目录另含可打包的连接器资产：

- `connector-meta.json` / `mcp.json` / `token-schema.json` / `icon.svg` — token 过渡包（auth_mode=token；`mcp.json` 与真实工具注册表全等比对，见 `tests/workbuddy-rfq-connector.test.ts`）。
- `skills/{rfq-intake,quote-build-review,quote-release-followup}/SKILL.md` — 三个技能草稿（§12.3）。
- 打包校验：`node package-rfq-workbench-connector.mjs --check`；出包 `--out <path>.zip`。

**仍属 M4 未完成项**：真实 WorkBuddy 实机（L2 证据）、每商家 URL/OAuth 配置实测、平台资源 ID 与生产地址批准（`mcp.json` 目前为 rfq-workbench.example.com 模板域）。不得把仿真测试当作实机证据。实机验收操作步骤见 [L2 实机验收清单](../../../docs/merchant-rfq-pilot/l2-host-checklist.md)。

公共目录网关仍只做目录，不提供商家实例路由。具名确认走独立管理页或受认证的CLI；任何模型工具均不拥有批准权限。MCP Apps UI为可选增强，文本降级不得丢失事实或绕过审批。
