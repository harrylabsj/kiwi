# Changelog

## v0.8.0 — 2026-09-03

**Merchant Experience + 公共宿主接入**：
- 商家 Agent 新增 intelligence、grounding、presentation、fencing 和 Host Event 能力，并提供独立 HTTP/SSE 接入层。
- 商家 skill 支持版本化加载、按需读取和生产包校验，保持权限、审批和 Handoff 边界不变。
- Hermes Buyer skill 改为公共路径，并优先从 npm 包内置资源安装；协议和架构文档统一指向当前权威版本。

## v0.7.22 — 2026-08-23

**Buyer 供应商关系（M0/M1）+ 官网源码移入私有仓库**：
- `feat(buyer)`：RFQ 成功后建议保存供应商——`supplier_save_suggested` 本地事件（M0）。
- `feat(buyer)`：Buyer-owned 供应商关系——`supplier_relationships` 存储 + pull-only 观察调度（M1）。
- `chore(website)`：官网源码移入私有运营仓库；公开仓库移除站点 bundle、Wrangler 配置与个人联系方式。

## v0.7.20 — 2026-08-21

**Buyer 身份透传 + 运营/采用素材**：
- `feat(buyer-core)`：catalog 搜索携带 `X-Buyer-Id` 买家身份（catalog 用量统计/去重买家）。
- `docs(strategy)`：产品战略升级基线 v2.5 系列文档与实现对齐说明。
- `docs(feedback)`：采用反馈渠道——issue 模板、反馈台账、访谈提纲与触达话术。
- `chore(scripts)`：Veyquo 端到端 RFQ 探测脚本（本地开发用）。
- `docs(website)`：官网联系方式调整为项目公开渠道；移除公开案例（内部信息）；商家页移除 Hermes 询价演示链接。
- `chore(lock)`：重锚 kiwi-catalog → `c6a0795`（0.2.5，商家接入 + 买家统计）。

## v0.7.19 — 2026-08-18

**DeepSeek Harness 一键安装插件（`@harrylabsj/kiwi-dsh-plugin`）**：
- 新增 `integrations/plugins/kiwi-dsh-plugin/`：dsh 插件包（`dsh.bundle.patch` →
  `cordis.patch.yml`），一条命令安装：
  `dsh plugin --profile web add @harrylabsj/kiwi-dsh-plugin`。
  - `cordis.patch.yml` 插入 `mcp-kiwi` 行（`@deepseek-ai/dsh-mcp-client` 把
    `kiwi mcp serve` 挂成 MCP 插件，9 工具 → `mcp__kiwi__*`）+ `kiwi-dsh-plugin`
    行（宿主插件注册 kiwi-buyer SKILL，教模型构造合法 CommerceIntent）。
  - `lib/index.js` 纯 ESM JS、零运行时依赖（不 import `@deepseek-ai/*`，规避
    ESM realpath 解析）；`scripts/validate.mjs` 是 prepack 门。
  - 已实测：本地 `dsh plugin add link:` 安装 → 两行合并 → kiwi mcp serve 子进程
    拉起（干净 args、无 `!!js` 残留）、无 duplicate serverName、skill 注册。
- `portfolio-release.yml` 扩展：新增 `publish-dsh-plugin` job（`@harrylabsj/kiwi-dsh-plugin`
  npm 受保护发布，同 `kiwi-release` 环境 + OIDC trusted publisher）；build-once 打包
  `release/dsh-plugin/`；verify-registry / rollback-verify 覆盖该包。

**MCP 默认路径与 schema 修复（所有宿主受益）**：
- `kiwi mcp serve` 默认持久 store 路径：`--db` → `KIWI_MCP_DB` env →
  `~/.kiwi/mcp/dsh.sqlite`（HOME 基准，不再依赖 cwd；dsh/Hermes 等 host 不传
  --db 也能落一致位置）。
- `kiwi_request_quotes` 工具 schema 完整暴露 `items[].query`（必填）+ `quantity`
  `{value, unit}` object（ff4e077）：修复 dsh/其他宿主模型因缺 schema 引导而构造
  非法 CommerceIntent（contract_violation）。

## v0.7.18 — 2026-08-18

**商家配送时效（按区域）——发现/搜索可见**：

- 商家新增**一个字段**维护按区域配送时效（如 `东北 3-4天；华北 1-2天`）：
  `shopping-cli delivery set-time --merchant <id> --region <区域> --min-days <n>
  --max-days <n>`、`delivery remove-time`、`delivery times`；字段存
  `delivery_rules.delivery_times_json`（区域 → {min_days, max_days}，min/max 正
  整数且 1 ≤ min ≤ max ≤ 365）。
- 商品 listing 投影（shopping-cli 3.2.5）把商家时效填进公开发现 hint：
  `commercial_hints.fulfillment_regions` + `lead_time_hint`（如 `东北 3-4天；华北
  1-2天`），并回填 `regions`（区域搜索生效）。买家 `kiwi-catalog-listings` 经既有
  `commercial_hints` 通道直接可见，无需改买家工具。
- `kiwi_search` 商家结果（MerchantRecord）新增 `delivery` 字段（来自 listing 的
  `commercial_hints.lead_time_hint`），配送时效成为买家发现/选择的重要指标。
- 单价投影 `get_listing_projection` 修复：此前 `merchant_id` 缺省 "" 会让商家级
  delivery_times 在该路径静默丢失（与 S-M3 同类 bug），现由商品 owner 派生。

> 磋商报价真实化（买家区域传进 RFQ、商家 offer delivery_before 按区域计算）为
> 二期，本期只做发现/搜索可见。配送时效是公开发现指标（买家询价前可见），价格
> 与私密供应事实仍留在本地。

## v0.7.17 — 2026-08-18

> v0.7.16 由 2026-08-17 的 workflow run 发布（缺下述新功能，不可覆盖）；本版
> **0.7.17 为完整版**，请安装 0.7.17。

**商家接入零参数（商家侧一站引导）**：
- `kiwi merchant init` TTY 引导输入商家名称、公网域名、商家令牌；域名写入
  profile `merchant_public.public_url`，令牌写入独立 0600 `~/.kiwi/credentials.env`
  （secret 不入 profile，start/publish 自动加载）。
- `--profile` 缺省回退 `~/.kiwi/kiwi.yaml`（`requireProfileOrDefault`）；
  `--shopping-cli-db` 缺省 `~/.local/share/shopping-cli/shopping-cli.sqlite`（与
  shopping-cli 一致，商家无需设置 SHOPPING_DB_PATH）。
- 新增 `kiwi merchant setup-public`：公网 A2A 引导（检测公网 IP、检查域名 DNS、
  生成 Caddyfile），域名缺省从 `KIWI_A2A_PUBLIC_URL` 提取。
- 新增 `kiwi merchant up`：一条命令上线（setup-public → 起 Caddy 反代 → 起 A2A
  节点，退出时清理 Caddy），把第 4 步三命令合成一个。
- `kiwi merchant publish --file <csv>`：先导入商品再发布；名称-only 投影
  （shopping-cli 3.2.4）。

**买家用 Hermes 一键接入**：
- 新增 `kiwi setup-hermes`：`hermes mcp add` 把 `kiwi mcp serve` 接成 MCP server
  + `hermes skills install` 装 kiwi-buyer skill；检测已配置则跳过，skill 安装失败
  时兜底直接写入 `~/.hermes/skills/kiwi-buyer/`。

**组合发布**（portfolio，3.2.4 / 0.2.4 / 0.7.17）：
- `shopping-cli@3.2.4`：商品发布投影改为**名称-only**（去掉价格/促销/底价），
  新增 `import-csv-excel --template` 与 `examples/products-template.csv`。
- `kiwi-catalog@0.2.4`：移除门户「我的商品」discovery entries（买家搜索只走
  listings）；门户导航与官网一致（买家/商家/商家后台）。

**官网**：商家四步接入（安装→初始化→上线→导入并发布）、买家 Hermes 二步接入、
导航短名（买家/商家）。

## v0.7.16 — 2026-08-17

**Northbound（战略 v2.5 Phase 1 / Phase 2 Hermes 轨）**：
- 冻结四份 Northbound 契约（v0.1）：CommerceIntent / DelegationPolicy /
  EffectiveAuthorization / PersistentTask，schema 单一来源 `contracts/`，
  向量测试 + 运行时校验 `src/contracts/northbound-schema.ts`。
- 新增 `kiwi mcp serve`（kiwi-buyer-mcp 薄 facade）：手写 stdio MCP server，
  暴露 7 个高层 Sourcing Tools（kiwi_search/request_quotes/get_task/negotiate/
  accept_agreement/get_agreement/handoff），持久 Task/Approval store
  （node:sqlite），五层授权 deny 优先，幂等 + 重启恢复 + fail-closed 协议面。
- Hermes Host reference integration：`integrations/hosts/hermes/SKILL.md` +
  MCP 配置；Hermes 自动发现 7 工具并真实调用 kiwi_search（端到端验证）。
- `--catalog-url` 接线 kiwi-catalog 发现（KiwiCatalogMerchantIndex，
  §3.2 Discovery & Routing Index）；catalog 不可达时优雅降级 note。
- **真实 RFQ fan-out（Phase 2 Supply 轨）**：`MarketplaceQuoteFetcher`
  （`--marketplace-url` + `--buyer-bootstrap-token`）经 shopping-cli marketplace
  创建定向会话、轮询商家 daemon 真实回复，candidate 携带 provenance +
  reply_text（真实价格/库存/交付）。`scripts/pilot/` 自建 5 家真实数据商家
  （办公/IT 48 商品 CSV 数据源，含共享大宗商品差异化定价）+ marketplace/商家
  daemon 启动脚本。
- **真实发现 + 证据门（Phase 2）**：`MarketplaceMerchantIndex` 用 `/search/products`
  商品 FTS 路由 + CJK 相关度过滤 → 各商家 matching_skus（RFQ 用商家自有 SKU，
  多商家比价成立）；`register-catalog.sh` 把 5 家商家注册进 kiwi-catalog
  （admin token + merchant_id 绑定）；`evidence-gate.mjs` 批量真实 RFQ +
  可审计报告（26/26 Qualified RFQ，5 家比价 DOCK-6IN1 真实报价
  189/199/209/185/195 CNY）。
- **真实磋商（Negotiator）**：`MarketplaceNegotiator`（claim→counter(proposal)→
  complete→轮询商家回复），循环端到端验证（CONV-0071）；proposal 库存/价格从
  商家回复解析对齐（stale_inventory 防护）。
- **DeepSeek Harness 第三轨**：`integrations/harnesses/deepseek-harness/`——
  受限 ReasoningBackend（只产不可信 DecisionCandidate，0 越权写）；
  contract gate **双模式全过**：mock 24/24 + 真实 DeepSeek V4 Flash（`--real`，
  schema 驱动 + json_object）24/24，均 **0 越权写**；`npm run verify:harness` 入 verify 链。
- **单核心多包装（Phase 3 §6.3）**：`buildBuyerService` 共享 Buyer Core；
  新增 HTTP 包装 `kiwi buyer-api serve`（`src/http/`）——与 MCP 同一核心、
  同一语义不变量，真实冒烟拿到商家报价。MCP/HTTP 均为薄适配器。
- **Merchant UCP Profile（§7.1/§7.8）**：`src/merchant/ucp-profile.ts` 生成合法
  `/.well-known/ucp` profile（catalog service + KNP capability，§8.3 命名不变量）；
  HTTP 端点 `GET /merchants/:id/ucp`（`--ucp-config`）。
- **Merchant Ops API（§7.6/§7.7）**：`src/merchant/ops.ts`（MerchantOpsService：
  RFQ 队列 / human_required / resolve-review / analytics，merchant token 作用域，
  命名空间与 buyer 分离）；HTTP `GET /merchant/:id/{rfqs,human-review,analytics}`
  + `POST /merchant/:id/resolve-review`（`--merchant-tokens`）。
- **插件发布供应链（§6.11）**：`scripts/verify-facade-supply-chain.mjs` 生成运行时
  依赖 SBOM（lock 的 resolved+integrity，fail-closed）+ 发布物 sha256 + 版本兼容
  fail-closed；`npm run verify:supply-chain` 入 verify 链。
- **Merchant Independence（§7.4）**：`scripts/pilot/merchant-independence.sh`
  关推理 harness 后商家独立应答真实 RFQ。
- **兼容性工件**：`compatibility/{ucp-knp-boundary,host-harness-matrix,merchant-three-plane}.md`
  登记入 CURRENT-DOCS（§6.10 语义不变量 + UCP/KNP 边界 + §7.5 三 Plane）。
- **Merchant 三 Plane（§7.5）**：`merchant-three-plane-check.sh` 验证 Failure rule
  （Intelligence 离线时 Commerce+Merchant Core 仍 RFQ 报价 / human_required 升级 /
  运营 resolve，PASS）。
- 文档：`docs/kiwi-buyer-mcp-facade-v0.1.md` 登记入 CURRENT-DOCS.md。

**Host adapter 与 Merchant pricing**：
- 新增 `kiwi-buyer-openclaw` 薄适配器与 Skill；它只连接 `kiwi-buyer-mcp`，不复制 Buyer Core 或 KNP 状态机。
- Merchant 报价与促销由确定性 `merchant_policy` 执行，支持 per-SKU floor、折扣上限和批量促销；LLM 只保留为受限候选生成/contract gate，不是定价权威。
- 发布候选版本统一为 Kiwi `0.7.16`、kiwi-catalog `0.2.4`、shopping-cli `3.2.2`。

- A2A 1.0 KNP 响应统一使用 `text`/`data` Part 与 `ROLE_*` wire 形状，0.3 兼容响应保持不变。
- malformed 1.0 Part 现在在协议边界 fail-closed，避免远端输入触发内部 500。
- Python 参考实现与 CSV/Excel 适配器增加响应、请求体、文件、行、列和压缩包资源上限。
- 组合 CI 增加官方 SDK 往返与三向独立实现 conformance，并上传 wire transcript 证据。

## v0.7.8 — 2026-08-14

**签名身份持久化**：统一 chat/A2A 节点的签名密钥与 trusted-keys 目录，并让节点重启后继续使用持久化的签名状态；同步重锚组合发布元数据。

## v0.7.7 — 2026-08-14

**安全身份与发布元数据**：trusted-keys 注册表、出站 HTTP Message Signature 闭环，以及组合锁重锚。

## v0.6.1 — 2026-08-09

**修复与商家侧支持**（shopping-cli v3.0 发布面剥离后的契约对齐）：

### 商家部署（Veyquo 实装驱动）

- 新增 `KIWI_MERCHANT_TOKEN`：商家用自己签发/找回的随机 token 绑定 merchant_id
  注册 Agent（register.ts / a2a node / cli serve+publish 直传优先，HMAC 派生兜底）
  ——平台 `KIWI_CATALOG_OWNER_TOKEN_SECRET` 不再需要出现在商家服务器；
- `kiwi merchant publish` Step 2 重构：读 shopping-cli `listings projections
  --format json` 投影 → 直连 catalog `POST /v1/listings/publish`（剔除 `_` 前缀
  内部字段；owner token 直传优先/HMAC 兜底；投影读取非零退出/非 JSON fail-closed），
  修复 `publish-listings` 命令被 shopping-cli v3.0 剥离后的发布失败；
- shopping-cli 兼容探测与调用路径支持 `--shopping-cli-path`（entry point 名
  `shopping-cli`，非 legacy `shopping`）。

### 其他

- 测试：1577 全过（新增发布失败明细、投影参数断言等）。

## v0.6.0 — 2026-08-07

**A2A v0.6.0 正式发布**（当日由 v1.0.0 回退版本号；KNP 协议身份不变，基线 §41 完成定义
27/27 经就绪度审计 `docs/kiwi-a2a-v1.0-readiness-audit-2026-08-06.md` 逐条实证满足）。

### 协议与发布

- §41 #6：公开稳定 namespace `com.harrylabsj.kiwi.shopping.negotiation`，spec/schema 托管于
  `https://kiwi.harrylabsj.com`（Cloudflare Pages，公开仓库 `harrylabsj/kiwi-spec`）。
- §41 #7：九类核心 Negotiation Objects 冻结为 JSON Schema（`contracts/negotiation/1.0/schema.json`），
  与领域实现交叉一致性对齐（digest 必填、offer-like items 要求 unit_price、withdraw/decline scope 约束等）。
- 协议文档状态 Draft → Normative（Released）；基线 §41 加盖宣布戳。

### 实现（v0.4–v1.1 累计）

- **v0.4 谈判基础**：KNP 领域模型、条件求值器、Ledger、幂等、Legacy Adapter。
- **v0.5 原生 A2A**：Agent Card、A2A client/server、Task 生命周期与恢复、Channel 抽象、鉴权。
- **v0.6 UCP interop**：profile 模型/resolver、capability intersection、well-known 服务、UCP-Agent、双入口发现。
- **v0.7 开放网络**：trust records、fan-out 隐私 + 多商家 RFQ、服务端限流、interop E2E。
- **v1.1 交易 handoff**：agreement→checkout 桥、UCP checkout channel、operator 授权、只读 order records、ACP-Commerce 接缝。
- **发现层**：ShoppingCliCatalogSource（Agent Catalog 作为发现源）、UCP cart capability client。

### 验证

- 全部离线测试全绿（`npm run verify`：lint/typecheck/build/test/package）。
- 测试计数以 `npm run verify` 实际输出为准（README 同步维护）。

### 行为边界（§41 #25/#26/#27）

- KNP/1.0 在非绑定商业协议处终止：不创建订单、不执行支付、不锁库存
  （agreement 三副作用 flag 恒为 `false`，schema 与领域双重强制）。
