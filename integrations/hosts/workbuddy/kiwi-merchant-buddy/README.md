# Kiwi 商家运营工作台 Buddy 应用配置草稿

`buddy-app.config.json` 是 Buddy 后台配置的本地草稿：官方文档说明后台「支持导出配置 JSON 文件在本地环境测试验证」，但导出格式未公开。本文件为自定义清晰结构，供导出预览和人工照着配置；每次退出配置前后台导出文件，下次导入还原（官方最佳实践第 5 条）。

对应连接器包见 `../kiwi-merchant-gateway-connector/`（远程 HTTPS MCP + OAuth，source=`kiwi-merchant`）。v1.1.0 的旧平台资产已撤回；WP22 正准备 v1.2.0 七工具候选送审包；尚未上传，需平台生成新 ID 并完成审核后配置到 Buddy 内置连接器。

## 五个后台模块怎么填

### 模块 1：创建应用

- 应用名称/简介/头像：取 `identity` 段；头像上传 `avatars/kiwi-merchant-buddy.png`（256×256 PNG，小于 100KB）。2026-09-20 已在创建表单核对文件可接受；但平台尚未生成应用 ID。
- 授权列表 / 授权回调 URL：商家连接器使用 OAuth；连接器回调由 `source=kiwi-merchant` 派生。应用级授权回调属于 Buddy 应用自身，当前无 Open API 权限时留空，不填占位地址。
- 可信 Origin：填实际部署的 Buddy/网关域名；提交前替换文档中的占位值。
- 创建后保存 Client ID 与 Client Secret（Secret 仅展示一次）。

> **创建审核阻碍（2026-09-20）**：上述头像、名称、简介和「商家自营 - B2b」类目均已填好；授权列表与应用级 OAuth 回调留空时「提交审核」仍禁用。权限菜单没有“无权限”选项，现有权限均非本版目录工具所需。不能申请无关权限或填写无效回调；需平台确认最小权限创建方式。

### 模块 2：首页配置

- 首页标题（Slogan）、欢迎语：取 `home.slogan` / `home.welcome`。
- 工作模式：按 `buddy-app.config.json` 配 4 个模式——①注册开通 ②日常运营 ③曝光优化 ④客服准备，各配 System Prompt 与 `kiwi_catalog_*` 工具；「注册开通」模式另挂技能 `kiwi-cloud-deploy`（1.7.0 起，云端接待一键部署），「日常运营」模式另挂技能 `kiwi-product-import`（1.7.0 内 WP12 新增，商品导入表整理）。
  - **没有实例读写模式**（商品查看 / 询价处理 / 库存与变更草稿）：按[「网关不碰实例」](../../../../docs/merchant-buddy/merchant-connector-deployment.md)原则（部署说明 §0）刻意去掉——网关不持有实例地址与凭据、不代理实例工具；商家实例独立部署、直接与买家做 A2A。`kiwi-cloud-deploy` 不经网关：它在商家自己的 Buddy 会话里用平台发布工具（V1 实测：`workbuddy_sites_deploy`/`workbuddy_sites_unpublish`，无 inspect/activate/deploy）把接待运行时部署到**商家名下**的云端应用。
- 场景胶囊：按配置文件中的胶囊逐项验证（注册开通 7 个、日常运营 6 个、曝光优化 6 个、客服准备 5 个）。注册开通模式的「一键开通云端接待」「升级接待服务」（1.7.0，替换了与「上线检查」重复的「开通进度」）依赖技能资产审核与真实发布实测，未就绪前预览会按方案 B 输出提示词。
- 内置连接器：使用 `kiwi-merchant-gateway-connector` 的 OAuth MCP，只提供目录工具。`kiwi_merchant_*` 实例工具**本就不该出现**，不要为此排障。

### 模块 3：市场配置

- 连接器：待 v1.2.0 审核通过后，使用平台新生成的资产 ID 配置 Buddy 内置连接器，并核对其只暴露预期的 7 个目录工具。不得引用已撤回/删除的历史资产 ID。技能三个：`skills/kiwi-merchant-cs-prep/` 已作为 `os_dc3a52407574eb77` 提交审核，发布后再加入应用市场，它只准备客服 FAQ/回复草稿，不自动接待客户；`skills/kiwi-cloud-deploy/`（1.7.0 新增）云端接待一键部署，**需单独提交技能资产审核**；执行路径已按 V1 实测改用 `workbuddy_sites_deploy`（首次发布取地址 → prepare → 同一应用再发布 → 自检）、发布参数已回填（WP17，绑定 0.11.0 合并线产物），剩余前置为**真实发布实测**（费用/弹窗需东哥确认）与 npm 正式发布后复核 integrity，见配置 `$pending.skills`；`skills/kiwi-product-import/`（1.7.0 内 WP12 新增）商品导入表整理（列映射确认 → 生成模板一致 CSV + 问题清单 → 引导工作台上传），**需单独提交技能资产审核**（不依赖平台工具，审核前可退回普通任务执行），见配置 `$pending.skills`。「日常运营」模式「整理商品」胶囊以 `bindSkills` 表达技能绑定；平台若不支持胶囊级技能绑定，以模式 skills 为准。
- 专家：不配置；专家页精选场景也不配置（需要关联专家/专家团）。

### 模块 4：其他配置

- 跳过首次绑定应用授权：OAuth 商家连接器 = 关闭；是否能把绑定延后到用户主动使用时，必须在 WorkBuddy 预览中验证。
- 绑定应用授权文案 / 输入框占位符（中英）：取 `misc` 段。
- 模型：从平台模型池勾选工具调用稳定的通用模型，默认模型按平台推荐；不引用 Kiwi 本地模型配置。

### 模块 5：预览调试

提交审核前用预览链接在 WorkBuddy 客户端打开预览态，逐项过一遍各模式与全部胶囊；另外手动验证市场中的三个技能。`kiwi-cloud-deploy` 的预览要点：①确认会话里是否存在发布工具 `workbuddy_sites_deploy`（V1 实测该工具存在、无 inspect/activate/deploy）——不存在时应按方案 B 原样输出 `references/fallback-prompt.md` 提示词（占位已发布后可用 release.json 回填值替换）；②核对 `references/release.json` 三个值与技能正文一致（0.12.0 / sha256 / sha512）；③一次性口令只展示一次；④真实发布实测未做，预览里不得宣称一键上云已验证。`kiwi-product-import` 的预览要点：①贴一段含底价列的商品表格，应先确认列映射并剔除底价列、不编造缺失价格；②生成的 CSV 列名应与工作台「商品与导入」页模板一致（`references/columns.md`）；③应提醒整表替换语义并引导商家本人在工作台上传确认。

## 平台导入步骤（WP18：1.7.0 草稿 → 平台格式配置包）

`platform/build-platform-pack.mjs` 以 `buddy-app.config.json`（1.7.0）为唯一内容源，生成平台「导入配置」用的 `platform/out/industry-config.json` 与 `platform/out/icons/*.svg`（模式 4 + 胶囊 20，共 24 个）。生成器内置全部平台规则校验（模式 3–5、每模式 ≥5 胶囊、名称 ≤5 汉字/英文 ≤30、每胶囊 4–10 条模板、无 bindTools/bindSkills、禁词等），不通过即失败；改动配置后必须重新生成（`tests/workbuddy-platform-pack.test.ts` 会校验落盘产物与构建结果一致）。

```sh
node integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/build-platform-pack.mjs
```

导入与核对步骤：

1. **导入配置**：平台配置页「导入配置」→ 选 `platform/out/industry-config.json`。`templateId` 留空（导入时平台按应用 ID `cb_jU2kgRjXVRjE2gmSjgyH` 校验，不一致会报 idMismatch）；`version` 先按 `1.0.0`，导入失败按报错调整。
2. **逐个上传图标**：`mode-*.svg` 4 个 + `cap-*.svg` 20 个。文件名需与配置内 `iconFileName` 一致；若平台支持 zip 导入（内含 `icons/`），可改为打包导入，以平台实际行为为准。
3. **选择内置连接器**：Kiwi 商家运营连接器 `oc_0053ad85c92a6587`（已写入 `jointAuth.connectorName`，界面核对即可）；不得引用已撤回的 `oc_c86216e2a36110bf`。
4. **核对**：4 模式 × 5 胶囊 × 4 模板；`header.title` 留空的在界面填品牌名/标语「Kiwi商家 / 让采购专家找到你」（两字段的分隔方式平台未公开）；技能 `kiwi-cloud-deploy`、`kiwi-product-import` 尚无平台资产 ID，导入包中模式 skills 为空，审核通过后回填脚本 `SKILL_ASSET_IDS` 并重新生成导入。
5. **生成预览**：预览并逐项检查（要点见「模块 5：预览调试」）。

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
- `mcp.json`：`tools` 数组是**非标准信息性声明**（官方 schema 无此字段，平台实际以 MCP `tools/list` 为准）；若后台校验拒绝未知字段，先核对运行时 7 个目录工具，再按平台要求调整包。`src/merchant-gateway/catalog-tools.ts` 是工具实现基线，本版没有实例工具。
- `mcp.json`：URL 必须指向真实多商家网关的 HTTPS `/mcp`；不能指向单个商家实例。
- Buddy 后台：内置连接器的 OAuth 限制、「跳过首次绑定」的适用性、应用 icon 设计规范（16px、线宽 1.2px、有断口）与连接器 icon 的关系。
