# Kiwi 商家运营工作台 Buddy 配置与提审状态说明

`buddy-app.config.json` 是 Buddy 后台配置的本地草稿：官方文档说明后台「支持导出配置 JSON 文件在本地环境测试验证」，但导出格式未公开。本文件为自定义清晰结构，供导出预览和人工照着配置；每次退出配置前后台导出文件，下次导入还原（官方最佳实践第 5 条）。

## 当前提审源入口（2026-10-13）

- 产品源文件分别维护在 `skills/`、`experts/`、`avatars/` 和 `../kiwi-merchant-gateway-connector/`。本页中带日期的平台状态与提审记录仅作历史说明，不代表当前状态；需以 WorkBuddy 当前页面核验。
- 本页保留的应用审核和技能资产 ID 记录观察日期为 2026-10-13。它们不证明当前草稿、审核或发布状态，也不应作为新的提交指令。
- 下方 WP18/WP22 与五模块内容是历史开发说明和旧流程记录，不代表当前官方提审包或当前审核状态。源文件与发布配置以仓库内规范产品目录为准。

对应连接器包见 `../kiwi-merchant-gateway-connector/`（远程 HTTPS MCP + OAuth，source=`kiwi-merchant`）。连接器 v1.2.0 已有提审资产 ID `oc_0053ad85c92a6587`；审核状态与配置可用性见当前资产登记。WP22 的准备与创建阻碍描述属于历史开发记录。

## 历史配置草稿说明（非当前提审步骤）

### 模块 1：创建应用

- 应用名称/简介/头像：旧流程曾使用 `identity` 段与 `avatars/kiwi-merchant-buddy.png`。2026-09-20 的尺寸验收和“尚无应用 ID”均为历史记录；当前应用及官方草稿状态见上方入口，不把旧头像或旧文案当作最新提审内容。
- 授权列表 / 授权回调 URL：下方关于应用级回调留空和权限缺失的内容是历史排障记录，不构成当前填表指示；按当前平台官方草稿和页面要求核对，不填占位值。
- 可信 Origin：旧草稿说明；当前值须来自实际部署信息与平台要求，不能把占位符提交。
- 凭据由账号所有者在安全界面自行保存或录入；Client Secret、一次性口令等不得进入模型上下文、对话、日志或普通文件。

> **历史创建审核阻碍（2026-09-20，仅作背景）**：旧草稿中头像、名称、简介和类目已填；当时回调留空后提交审核按钮仍禁用。该记录已被后续应用审核状态取代；不要当作当前平台页面状态或照此重复创建。

### 模块 2：首页配置

- 首页标题（Slogan）、欢迎语：取 `home.slogan` / `home.welcome`。
- 工作模式：按 `buddy-app.config.json` 配 4 个模式——①注册开通 ②商品报价 ③运营分析（含客服准备）④审批磋商（1.8.0，东哥四工作场景），各配 System Prompt 与 `kiwi_catalog_*` 工具；「注册开通」模式另挂技能 `kiwi-cloud-deploy`（云端接待一键部署），「商品报价」模式另挂技能 `kiwi-product-import`（商品导入表整理），「运营分析」模式另挂技能 `kiwi-merchant-cs-prep`。
  - **首发不直连实例**（运营明细 / 洽谈过程 / 待审批项都在商家实例工作台）：按[「网关不碰实例」](../../../../docs/merchant-buddy/merchant-connector-deployment.md)原则（部署说明 §0）——网关不持有实例地址与凭据、不代理实例工具；「运营分析」「审批磋商」的系统提示词写明首发边界：引导商家打开自己实例的工作台（运营报告 / 旁观洽谈 / 审批与规则表单），帮解读与起草，不编造数据；Buddy 内直连实例为第二版（WP16）。`kiwi-cloud-deploy` 不经网关：只有在当前 Buddy 会话实际提供相应能力且商家授权时才执行平台操作；不假设固定工具名、参数或能力清单。
- 场景胶囊：按配置文件中的胶囊逐项验证（注册开通 6 个、商品报价 6 个、运营分析 8 个、审批磋商 6 个；1.7.0 的 24 个胶囊按 WP25 对照表复用/合并/新增为 26 个）。注册开通模式的「一键上云」「升级接待」（1.7.0 起为「一键开通云端接待」/「升级接待服务」，1.8.0 改短名）依赖技能资产审核与真实发布实测，未就绪前预览会按方案 B 输出提示词。
- 内置连接器：使用 `kiwi-merchant-gateway-connector` 的 OAuth MCP，只提供目录工具。`kiwi_merchant_*` 实例工具**本就不该出现**，不要为此排障。

### 模块 3：市场配置

- 连接器：v1.2.0 的提审 ID 为 `oc_0053ad85c92a6587`（2026-10-13 历史记录）；当前审核/可用状态需以平台页面核实。下方 WP22 的“等待生成 ID”仅为旧开发说明。技能源文件和头像分别维护在 `skills/` 与 `avatars/skills/`；下列版本与提审 ID 也是 2026-10-13 的历史快照，不代表审核通过或当前可用：`kiwi-cloud-deploy`（0.2.3，`os_1ea25f81ce98fea3`）、`kiwi-product-import`（0.1.3，`os_32c612d72d2c3bcd`）、`kiwi-merchant-cs-prep`（0.1.1，`os_dc3a52407574eb77`）、`merchant-source-evidence-audit`（0.1.0，`os_6aedc97ac49e2d5b`）、`merchant-trade-link-check`（0.1.0，`os_9bc616f4fb80a452`）、`merchant-inquiry-structuring`（0.1.0，`os_fe982aad31a98bfb`）、`merchant-quote-draft`（0.1.0，`os_053e9e8722df80e6`）、`merchant-approval-brief`（0.1.0，`os_03cf120a20b00aae`）、`merchant-operations-insights`（0.1.0，`os_e64be8878bbb4349`）、`merchant-catalog-preflight`（0.1.0，`os_50c0414417e25586`）。「商品报价」模式「整理商品」胶囊以 `bindSkills` 表达技能绑定；平台若不支持胶囊级技能绑定，以模式 skills 为准。
- 专家：以下 `platform/market-draft/` 和生成器维护说明是旧开发记录。专家审核与发布状态须以 WorkBuddy 当前页面核实；本页中的状态仅是有日期的历史背景。

### 模块 4：其他配置

- 跳过首次绑定应用授权：OAuth 商家连接器 = 关闭；是否能把绑定延后到用户主动使用时，必须在 WorkBuddy 预览中验证。
- 绑定应用授权文案 / 输入框占位符（中英）：取 `misc` 段。
- 模型：从平台模型池勾选工具调用稳定的通用模型，默认模型按平台推荐；不引用 Kiwi 本地模型配置。

### 模块 5：预览调试

提交审核前用预览链接在 WorkBuddy 客户端打开预览态，逐项检查各模式、胶囊及十项技能候选内容（平台实际支持范围内）。`kiwi-cloud-deploy` 预览时按当前会话真实工具清单与权限判断可做步骤；工具或能力不足就说明限制，不借用其他平台能力。release.json 的 0.12.0 是已核验的历史固定包版本，不代表最新版本；不要擅自更换 pin。一次性管理员口令不得进入模型上下文、对话、日志或文件；若命令会将秘密输出到模型可见 stdout，停止并由商家本人在安全界面处理。没有实际发布验收时，不宣称一键上云已验证。`kiwi-product-import` 预览应检查映射确认、私密底价剔除、缺失值不编造、模板列顺序及整表替换提醒。七项新增技能只基于商家主动提供的材料起草核查结果，不代替商家发布、订单、支付或审批。

## 历史平台导入开发记录（WP18/WP19/WP25；非当前官方提审源）

历史实现中，`platform/build-platform-pack.mjs` 曾以 `buddy-app.config.json`（1.8.0）生成本地预览包；本地生成物不是当前官方草稿或提审状态的证明。核对当前状态请访问 WorkBuddy 平台页面。

- `platform/out/industry-config.json`：平台「导入配置」用（模式 4 + 胶囊 26 = 30 个图标引用）；
- `platform/out/icons/*.svg`：30 个图标（`mode-*.svg` 4 + `cap-*.svg` 26）；
- `platform/out/market.json` + `platform/out/platform-pack.zip`：市场配置（5 专用专家 + 1 专家团 + 4 精选场景）与 zip 导入验证包（`<应用ID>/industry-config.json` + `icons/` + `market.json`，验证 zip 导入是否随包带图标）；
- `platform/market-draft/`：市场配置草稿（中英双语 + README，已回填的专家资产 ID、审核状态与剩余待回填清单）。

生成器内置全部平台规则校验（模式 3–5、每模式 ≥5 胶囊、名称 ≤5 汉字/英文 ≤30、每胶囊 4–10 条模板、无 bindTools/bindSkills、禁词、首页标题中文两字段合计 ≤15 字/英文 ≤8 词、市场配置专家/场景规则、生成物不得出现 inspect/activate/deploy 旧口径步骤词等），不通过即失败；改动配置后必须重新生成（`tests/workbuddy-platform-pack.test.ts` 会校验落盘产物与构建结果一致）。

```sh
node integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/build-platform-pack.mjs
```

导入与核对步骤：

1. **导入配置**：平台配置页「导入配置」→ 选 `platform/out/industry-config.json`（或直接试 `platform/out/platform-pack.zip` 验证图标随包）。`templateId` 留空（导入时平台按应用 ID `cb_jU2kgRjXVRjE2gmSjgyH` 校验，不一致会报 idMismatch）；`version` 先按 `1.0.0`，导入失败按报错调整。
2. **上传图标**：若 zip 导入未带图标，则逐个上传 `mode-*.svg` 4 个 + `cap-*.svg` 26 个，文件名需与配置内 `iconFileName` 一致。
3. **选择内置连接器**：Kiwi 商家运营连接器 `oc_0053ad85c92a6587`（已写入 `jointAuth.connectorName`，界面核对即可）；不得引用已撤回的 `oc_c86216e2a36110bf`。
4. **核对首页标题**：`header.title` 已填「Kiwi商家·让采购专家找到你」（分隔格式集中在生成器 `HOME_TITLE_SEPARATOR` 一处；平台精确格式未确认，导入实测后只改这一常量）。
5. **市场配置（历史操作记录）**：市场侧专用专家与专家团曾创建并送审；该段落不代表当前审核状态。平台导入和资产绑定状态须以 WorkBuddy 当前页面为准。
6. **技能资产**：10 项独立技能的本地源文件与头像分别维护在 `skills/<slug>/` 和 `avatars/skills/<slug>.png`。上方版本与审核 ID 是有日期的历史快照；只在平台核实审核通过且资产可用后，按平台实际要求配置引用。
7. **生成预览**：预览并逐项检查（要点见「模块 5：预览调试」）。

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
