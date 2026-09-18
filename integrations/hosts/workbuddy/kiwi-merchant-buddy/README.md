# Kiwi 商家运营工作台 Buddy 应用配置草稿

`buddy-app.config.json` 是 Buddy 后台配置的本地草稿：官方文档说明后台「支持导出配置 JSON 文件在本地环境测试验证」，但导出格式未公开。本文件为自定义清晰结构，供导出预览和人工照着配置；每次退出配置前后台导出文件，下次导入还原（官方最佳实践第 5 条）。

对应连接器包见 `../kiwi-merchant-gateway-connector/`（远程 HTTPS MCP + OAuth，source=`kiwi-merchant`）。

## 五个后台模块怎么填

### 模块 1：创建应用

- 应用名称/简介/头像：取 `identity` 段；头像上传 256×256 PNG（复用连接器薄荷绿 kiwi 鸟风格，需另行出图，本仓库不放位图）。
- 授权列表 / 授权回调 URL：商家连接器使用 OAuth；连接器回调由 `source=kiwi-merchant` 派生。应用级授权回调属于 Buddy 应用自身，当前无 Open API 权限时留空，不填占位地址。
- 可信 Origin：填实际部署的 Buddy/网关域名；提交前替换文档中的占位值。
- 创建后保存 Client ID 与 Client Secret（Secret 仅展示一次）。

### 模块 2：首页配置

- 首页标题（Slogan）、欢迎语：取 `home.slogan` / `home.welcome`。
- 工作模式：按 `buddy-app.config.json` 配置的五个模式（目录注册与发布、连接自有服务、商品查看、询价处理、库存与变更草稿），各配 System Prompt 与商家连接器工具。
- 场景胶囊：按配置文件中的胶囊逐项验证；目录注册与自有服务连接是两个独立入口。
- 内置连接器：使用 `kiwi-merchant-gateway-connector` 的 OAuth MCP。未绑定商家实例时，第 0 版目录工具仍可用；实例工具应由网关按商家身份动态提供。

### 模块 3：市场配置

- 连接器：上架 `kiwi-merchant`；技能：上架 `kiwi-merchant`（连接器包内 SKILL.md）。
- 专家：不配置；精选场景可选。

### 模块 4：其他配置

- 跳过首次绑定应用授权：OAuth 商家连接器 = 关闭；是否能把绑定延后到用户主动使用时，必须在 WorkBuddy 预览中验证。
- 绑定应用授权文案 / 输入框占位符（中英）：取 `misc` 段。
- 模型：从平台模型池勾选工具调用稳定的通用模型，默认模型按平台推荐；不引用 Kiwi 本地模型配置。

### 模块 5：预览调试

提交审核前用预览链接在本端打开预览态，逐项过一遍三个模式与七条胶囊。

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

   公网入口用 HTTPS 反代（如 Caddy）到网关 `/mcp`；商家自有实例另行在 `/instance` 页面通过令牌或一次性配对码绑定。第 0 版目录能力不要求先绑定实例。

2. 用 WorkBuddy 预览态绑定新增商家连接器，完成目录注册/登录、邮箱验证、公开资料草稿和门户确认发布。
3. 已有实例的商家在 `/instance` 页面完成配对；验证 A/B 商家只看到各自目录、实例工具和审批候选。
4. 验证失败路径：OAuth 拒绝、状态 cookie 缺失/重放、目录凭据过期、错误实例令牌、实例响应超限、服务离线，以及未配置加密密钥时第 0/1 版工具的 fail-closed 行为。

## 需在 WorkBuddy 后台核对的字段

- `connector-meta.json`：OAuth 包省略 `auth_mode`；`source: "kiwi-merchant"` 的全局唯一性；平台生成的新连接器 ID 不得复用买方 `oc_bd73f860e3e2b5d3`。
- `mcp.json`：`tools` 数组是**非标准信息性声明**（官方 schema 无此字段，平台实际以 MCP `tools/list` 为准）；若后台校验拒绝未知字段，删除该数组即可，第 0 版目录工具以 `src/merchant-gateway/catalog-tools.ts` 为准，第 1 版实例工具按运行时 `tools/list` 动态提供。
- `mcp.json`：URL 必须指向真实多商家网关的 HTTPS `/mcp`；不能指向单个商家实例。
- Buddy 后台：内置连接器的 OAuth 限制、「跳过首次绑定」的适用性、应用 icon 设计规范（16px、线宽 1.2px、有断口）与连接器 icon 的关系。
