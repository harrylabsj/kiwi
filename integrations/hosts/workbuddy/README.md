# Kiwi WorkBuddy 专家

职称：**Kiwi 采购询价**；花名：**海纳·采购专家**。专家版本独立从 1.0.0 开始，不改变 Kiwi 运行时版本。

`kiwi-procurement-expert/` 是完整专家包，包含 `.codebuddy-plugin/plugin.json`、Agent、三个预加载技能和 512×512 PNG 头像。专家只使用既有 Kiwi 买方 MCP 九个工具，复用现有审批与状态机。

连接器依赖 `oc_bd73f860e3e2b5d3` 来自用户提供的 WorkBuddy「Kiwi 采购询价」截图。包结构校验不能证明平台连接器当前状态和实际工具版本；首次安装联调需在 WorkBuddy 核对该 ID 以及九个工具是否可用。

## 校验与打包

在 Kiwi 仓库根目录运行（使用项目已有 Node、yaml、ajv 依赖和系统 zip）：

```sh
node integrations/hosts/workbuddy/package.mjs --check
node integrations/hosts/workbuddy/package.mjs --out /absolute/path/kiwi-procurement-expert-1.0.0.zip
```

脚本校验两层职称/花名一致、技能路径/预加载一致、PNG 尺寸和大小、引用的工具仍在 MCP 源码中、示例满足 CommerceIntent 契约；只打包明确列出的专家文件，不带数据库、凭据、运行时或 macOS 元数据，不覆盖已有压缩包。

## WorkBuddy 提交

在开放平台「专家 → 创建」上传 ZIP，核对：

- 专家职称：Kiwi 采购询价（对应 profession，不是 displayName）。
- 专家花名：海纳·采购专家（对应 displayName）。
- 市场展示分类建议：行业顾问；服务类目按平台实际可选项选择采购辅助/效率工具相关项。
- 三个示例问题、头像和介绍应由包正常解析。市场分类有时仍需在表单手动选择。

由用户授权发布后才提交审核。此适配不自动提交、不更新连接器、不发布 npm。后续修改原专家时保留平台生成的专家 ID；即使撤回后重新上传，平台也可能要求递增 version（微信专家已验证此要求）。

## 离线验收与线上联调

离线场景：只找供应商不发 RFQ；缺数量时不猜测；报价缺运费不声称到手总价；只制定还价方案不发送；接受/交接仅按对应授权和运行时审批推进；硬拒绝不绕过；任务恢复不重复询价。包校验只验证可确定的结构/契约，不代替这些对话行为的实测。

线上联调使用明确授权的测试供应商，验证搜索 → 询价 → 状态 → 比较 → 非约束性协议 → 交接；不会自动向真实商家发测试请求。Kiwi 不处理订单创建、支付和库存预留。

## 头像

内置 ImageGen 生成的原创插画，保存为 `kiwi-procurement-expert/avatars/kiwi-procurement.png`。提示词：绿色 kiwi 鸟，戴圆框眼镜、拿三项勾选清单，薄荷绿/深绿与少量暖橙，浅色背景，居中留白，无文字、无品牌标识；用于采购专家头像。

## Kiwi 商家工作台连接器与 Buddy 应用（阶段三）

`kiwi-merchant-connector/` 是商家侧 MCP 连接器包（MCP + Skill 方案，`auth_mode: "token"` 用户自填 Token，`source: "kiwi-merchant"`，版本独立从 1.0.0 起），对应 `kiwi merchant mcp serve` 启动的远程 MCP 服务（`src/mcp/merchant-server.ts`，streamableHttp，7 个 `kiwi_merchant_*` 工具）。`kiwi-merchant-buddy/` 是 Buddy 应用后台配置的本地草稿与填写说明。

校验与打包（在 Kiwi 仓库根目录运行，只读校验不联网）：

```sh
# token 过渡包（缺省）/ OAuth 正式包（阶段五起正式交付走 oauth）
node integrations/hosts/workbuddy/package-merchant-connector.mjs --check
node integrations/hosts/workbuddy/package-merchant-connector.mjs --bundle=oauth --check
node integrations/hosts/workbuddy/package-merchant-connector.mjs --bundle=oauth --out /absolute/path/kiwi-merchant-connector-oauth-1.0.0.zip
```

两个包：`kiwi-merchant-connector/`（`source: "kiwi-merchant-token"`，用户自填 Token，过渡）与 `kiwi-merchant-connector-oauth/`（`source: "kiwi-merchant"`，OAuth 2.1，无 auth_mode、无 token 占位——走 WorkBuddy 内置 OAuth 流程）。平台要求同一服务两种方式必须两个不同 source，已照此拆分。

脚本校验 connector-meta/mcp/token-schema 合法性、mcp.json 的 7 个工具名与 `src/mcp/merchant-tools.ts` 一致（防漂移的全等比对见 `tests/workbuddy-merchant-connector.test.ts`）、token 占位符与表单字段一一对应、icon.svg 无文字无脚本、SKILL.md frontmatter、包内无疑似凭据；只打包明确列出的 5 个文件，不覆盖已有压缩包。

提交：连接器目录打包后按开放平台「连接器」流程提交审核；Buddy 应用按 `kiwi-merchant-buddy/README.md` 逐模块人工配置。本适配不自动提交平台、不更新连接器、不发布 npm。staging 联调步骤见 `kiwi-merchant-buddy/README.md`；`mcp.json` 的 `tools` 声明与 `token-schema.json` 的 `docUrl` 等需在后台核对的字段也在其中列出。
