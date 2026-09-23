# Kiwi 商家运营工作台 Buddy 应用配置草稿

`buddy-app.config.json` 是 Buddy 后台配置的本地草稿：官方文档说明后台「支持导出配置 JSON 文件在本地环境测试验证」，但导出格式未公开。本文件为自定义清晰结构，供导出预览和人工照着配置；每次退出配置前后台导出文件，下次导入还原（官方最佳实践第 5 条）。

对应连接器包见 `../kiwi-merchant-gateway-connector/`（远程 HTTPS MCP + OAuth，source=`kiwi-merchant`）。v1.1.0 的旧平台资产已撤回；正在准备以 v1.1.1 重新提交，获批后使用 WorkBuddy 新生成的资产 ID 配置 Buddy 内置连接器。

## 五个后台模块怎么填

### 模块 1：创建应用

- 应用名称/简介/头像：取 `identity` 段；头像上传 `avatars/kiwi-merchant-buddy.png`（256×256 PNG，小于 100KB）。2026-09-20 已在创建表单核对文件可接受；但平台尚未生成应用 ID。
- 授权列表 / 授权回调 URL：商家连接器使用 OAuth；连接器回调由 `source=kiwi-merchant` 派生。应用级授权回调属于 Buddy 应用自身，当前无 Open API 权限时留空，不填占位地址。
- 可信 Origin：填实际部署的 Buddy/网关域名；提交前替换文档中的占位值。
- 创建后保存 Client ID 与 Client Secret（Secret 仅展示一次）。

> **创建审核阻碍（2026-09-20）**：上述头像、名称、简介和「商家自营 - B2b」类目均已填好；授权列表与应用级 OAuth 回调留空时「提交审核」仍禁用。权限菜单没有“无权限”选项，现有权限均非本版目录工具所需。不能申请无关权限或填写无效回调；需平台确认最小权限创建方式。

### 模块 2：首页配置

- 首页标题（Slogan）、欢迎语：取 `home.slogan` / `home.welcome`。
- 工作模式：按 `buddy-app.config.json` **只配一个模式——「目录注册与发布」**（第 0 版：注册、草稿、请求发布、读资料、撤回、**经营汇总（关注数 + 浏览量）**、**文案优化**），配 System Prompt 与 `kiwi_catalog_*` 工具。
  - **没有实例相关模式**（商品查看 / 询价处理 / 库存与变更草稿 / 连接自有服务）：按[「网关不碰实例」](../../../../docs/merchant-buddy/merchant-connector-deployment.md)原则（部署说明 §0）刻意去掉——网关不持有实例地址与凭据、不代理实例工具；商家实例独立部署、直接与买家做 A2A。若后台仍留有旧版的这些模式，按当前 v1.4.2 草稿配置覆盖。
- 场景胶囊：按配置文件中的胶囊逐项验证（当前 5 个，全部落在「目录注册与发布」）。
- 内置连接器：使用 `kiwi-merchant-gateway-connector` 的 OAuth MCP，只提供第 0 版目录工具。`kiwi_merchant_*` 实例工具**本就不该出现**，不要为此排障。

### 模块 3：市场配置

- 连接器：待 v1.1.1 审核通过后，使用平台新生成的资产 ID 配置 Buddy 内置连接器，并核对其只暴露预期的 6 个目录工具。不得引用已撤回/删除的历史资产 ID。技能：`skills/kiwi-merchant-cs-prep/` 已作为 `os_dc3a52407574eb77` 提交审核，发布后再加入应用市场。它只准备客服 FAQ/回复草稿，不自动接待客户。
- 专家：不配置；专家页精选场景也不配置（需要关联专家/专家团）。

### 模块 4：其他配置

- 跳过首次绑定应用授权：OAuth 商家连接器 = 关闭；是否能把绑定延后到用户主动使用时，必须在 WorkBuddy 预览中验证。
- 绑定应用授权文案 / 输入框占位符（中英）：取 `misc` 段。
- 模型：从平台模型池勾选工具调用稳定的通用模型，默认模型按平台推荐；不引用 Kiwi 本地模型配置。

### 模块 5：预览调试

提交审核前用预览链接在 WorkBuddy 客户端打开预览态，逐项过一遍一个模式与五条胶囊；另外手动验证市场中的 `kiwi-merchant-cs-prep` 技能。

## 发布流程

创建应用 → 填写基础信息 → 创建审核通过 → 分模块配置 → 预览调试 → 提交审核 → 发布上线。首次基础信息需通过创建审核进入草稿态；已发布应用的任何配置变更需重新提交审核。本仓库不自动提交平台。

## staging 联调步骤

1. 在 staging 主机启动商家网关入口：

   ```sh
   KIWI_CATALOG_CONNECTOR_TOKEN=<catalog-connector-token> \
   KIWI_GATEWAY_CREDENTIAL_KEY=<gateway-key> \
   kiwi merchant gateway serve \
     --public-url https://merchant-staging.example.com \
     --catalog-url https://catalog-staging.example.com \
     --host 127.0.0.1 --port 9200
   ```

   公网入口用 HTTPS 反代（如 Caddy）到网关 `/mcp`；本版网关不连接商家自有实例，第 0 版目录能力不要求部署实例。

2. 用 WorkBuddy 预览态绑定新增商家连接器，完成目录注册/登录、邮箱验证、公开资料草稿和门户确认发布。
3. 验证 A/B 商家只看到各自的目录资料，未部署实例的新商家也能完成首次连接；采购专家按商品词能找到已确认发布的资料，但不能把它误当作实时可询价商家。
4. 验证失败路径：OAuth 拒绝、状态 cookie 缺失/重放、目录凭据过期、网关离线，以及未配置凭据密钥时目录工具的 fail-closed 行为。不得预期 `kiwi_merchant_*` 实例工具。

## 需在 WorkBuddy 后台核对的字段

- `connector-meta.json`：OAuth 包省略 `auth_mode`；`source: "kiwi-merchant"` 的全局唯一性；平台生成的新连接器 ID 不得复用买方 `oc_bd73f860e3e2b5d3`。
- `mcp.json`：`tools` 数组是**非标准信息性声明**（官方 schema 无此字段，平台实际以 MCP `tools/list` 为准）；若后台校验拒绝未知字段，先核对运行时 6 个目录工具，再按平台要求调整包。`src/merchant-gateway/catalog-tools.ts` 是工具实现基线，本版没有实例工具。
- `mcp.json`：URL 必须指向真实多商家网关的 HTTPS `/mcp`；不能指向单个商家实例。
- Buddy 后台：内置连接器的 OAuth 限制、「跳过首次绑定」的适用性、应用 icon 设计规范（16px、线宽 1.2px、有断口）与连接器 icon 的关系。
