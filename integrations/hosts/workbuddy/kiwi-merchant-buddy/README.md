# Kiwi 商家运营工作台 Buddy 应用配置草稿

`buddy-app.config.json` 是 Buddy 后台配置的本地草稿：官方文档说明后台「支持导出配置 JSON 文件在本地环境测试验证」，但导出格式未公开。本文件为自定义清晰结构，供导出预览和人工照着配置；每次退出配置前后台导出文件，下次导入还原（官方最佳实践第 5 条）。

对应连接器包见 `../kiwi-merchant-connector/`（MCP + Skill 方案，`auth_mode: "token"` 用户自填 Token）。

## 五个后台模块怎么填

### 模块 1：创建应用

- 应用名称/简介/头像：取 `identity` 段；头像上传 256×256 PNG（复用连接器薄荷绿 kiwi 鸟风格，需另行出图，本仓库不放位图）。
- 授权列表 / 授权回调 URL：正式交付走 OAuth（`kiwi-merchant-connector-oauth`，无自填 Token）；按平台连接器 OAuth 流程配置。token 过渡连接器（`kiwi-merchant-connector`）才使用自填 Token，不配置授权。
- 可信 Origin：填实际部署的 MCP 域名（草稿中为 `https://mcp.merchant.example.com` 占位）。
- 创建后保存 Client ID 与 Client Secret（Secret 仅展示一次）。

### 模块 2：首页配置

- 首页标题（Slogan）、欢迎语：取 `home.slogan` / `home.welcome`。
- 工作模式：`home.modes` 三个（商品查看 / 询价处理 / 库存与变更草稿），各配 System Prompt 与绑定连接器工具。
- 场景胶囊：`home.capsules` 七条，挂在对应模式上。
- 内置连接器：官方要求内置连接器为 **OAuth 认证的 MCP**——使用 OAuth 包（`kiwi-merchant-connector-oauth`）满足；token 过渡连接器不满足，若用过渡包则跳过内置连接器，改在模块 3 市场上架，并在模块 4 开启「跳过首次绑定应用授权」。**需在后台核对**。

### 模块 3：市场配置

- 连接器：上架 `kiwi-merchant`；技能：上架 `kiwi-merchant`（连接器包内 SKILL.md）。
- 专家：不配置；精选场景可选。

### 模块 4：其他配置

- 跳过首次绑定应用授权：OAuth 正式包 = 关闭（走 WorkBuddy 内置 OAuth 绑定）；token 过渡连接器 = 开启（自填 Token 符合该条件）。
- 绑定应用授权文案 / 输入框占位符（中英）：取 `misc` 段。
- 模型：从平台模型池勾选工具调用稳定的通用模型，默认模型按平台推荐；不引用 Kiwi 本地模型配置。

### 模块 5：预览调试

提交审核前用预览链接在本端打开预览态，逐项过一遍三个模式与七条胶囊。

## 发布流程

创建应用 → 填写基础信息 → 创建审核通过 → 分模块配置 → 预览调试 → 提交审核 → 发布上线。首次基础信息需通过创建审核进入草稿态；已发布应用的任何配置变更需重新提交审核。本仓库不自动提交平台。

## staging 联调步骤

1. 在 staging 主机启动 MCP 服务：

   ```sh
   KIWI_MERCHANT_MCP_TOKEN=<staging-token> kiwi merchant mcp serve \
     --profile merchant.yaml --host 0.0.0.0 --port 9100
   ```

   非 loopback 监听必须配置 token，否则服务 fail-closed 拒绝启动；公网入口用 HTTPS 反代（如 Caddy）到该端口，路径 `/mcp`。

2. 用 WorkBuddy 导出/导入的预览 JSON（或按本草稿人工配置）创建预览态应用，连接器 URL 指向 staging 地址，表单填写 staging token。
3. 逐项验证 15 个工具连通：目录列表/单品/库存/磋商记录/人工队列/经营摘要/变更草稿（只产候选）+ 商品创建/库存调整/上下架/磋商裁决/策略变更（prepare 候选）+ CSV 导入/批量撤回（operation）/operation 查询；写工具一律确认「只产候选不执行」。
4. 验证失败路径：错误 token 401、未配置指标后端时经营摘要返回明确错误、未知 SKU 返回「未找到」。

## 需在 WorkBuddy 后台核对的字段

- `connector-meta.json`：`examples_zh/en` 需 ≥4.24.0、`auth_mode: "token"` 需 ≥4.23.0（已声明 `minWorkbuddyVersion: "4.24.0"`）；`source: "kiwi-merchant"` 的全局唯一性。
- `mcp.json`：`tools` 数组是**非标准信息性声明**（官方 schema 无此字段，平台实际以 MCP `tools/list` 为准）；若后台校验拒绝未知字段，删除该数组即可，工具名以源码 `src/mcp/merchant-tools.ts` 为准。
- `token-schema.json`：`docUrl`/`docLabel` 指向 example.com 占位，上线前替换为真实文档链接或删除该字段。
- Buddy 后台：内置连接器的 OAuth 限制、「跳过首次绑定」的适用性、应用 icon 设计规范（16px、线宽 1.2px、有断口）与连接器 icon 的关系。
