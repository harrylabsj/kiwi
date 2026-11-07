# WorkBuddy 商家连接器直连商家云实例：实施记录与平台缺口

日期：2026-11-07。状态：**本地实现，未上线、未提交连接器、未做真机验收**。
上位合同：`/Users/jianghaidong/coding/2026-11-07/kiwi-x20/outputs/workbuddy-linkluck-implementation.md`（外部任务目录，不在本仓库）。

## 1. 调查结论

### 1.1 已经具备的能力

- **实例自带标准 OAuth 2.1 授权服务器**（`src/auth/merchant-oauth.ts`，
  `src/mcp/merchant-server.ts`）：RFC 9728 / RFC 8414 元数据、RFC 7591 动态注册、
  授权码 + PKCE S256、refresh 轮换、RFC 7009 撤销；授权码与 token 只存 sha256。
  授权页要求实例管理员登录会话，`merchant_id` 与 `principal_id` 来自会话而非启动参数；
  单商家实例固定 `merchantId`，会话商家不一致时直接拒绝（跨商家授权拒绝）。
- **一次性配对码**（`src/auth/merchant-pairing.ts`、`/pairing/redeem`）：兑换时由实例
  新签单槽凭据，重配对即轮换；绑定要求实例 `owner_id === 当前目录 merchant_id`，
  不一致不落库（`src/merchant-gateway/instance-registration.ts`）。
- **实例 MCP 只读面**（`src/mcp/merchant-tools.ts`）：商品/库存/磋商/人工队列/
  经营摘要。
- **运营报告与洽谈投影**（`src/merchant/operations-report.ts`、
  `src/merchant/negotiation-observer.ts`）：day/week/month UTC 窗口与上一周期、
  指标 `available=false` + reason、金额与私密策略值不投影。

### 1.2 平台约束（未获平台确认）

WorkBuddy 连接器包（`mcp.json`）只描述**一个固定** `streamableHttp` URL；
现有 OAuth 包与 token 包都是“一包一实例”。本仓库没有找到“同一连接器按最终用户
动态路由到不同商家实例 URL”的平台能力证据，也没有在平台上上传/审核/真机验证过
这种能力。因此：

- **不能声称** WorkBuddy 的固定连接器可以连接任意商家实例；
- 通用商家入口只能继续承载目录能力；商家私有运营数据必须由**该商家自己的实例**
  直接提供；
- 每个实例的直连包需要以已验证的实例 URL 生成（或等待平台提供按用户 URL/OAuth
  配置能力）。当前 `kiwi-merchant-connector-oauth/mcp.json` 已改为
  `https://your-instance.example.com/mcp` 模板并附 `$note`，**不得**再指向共享网关。

## 2. 本阶段实现

| 交付 | 位置 |
| --- | --- |
| 实例只读工具：`kiwi_merchant_get_operations_report`、`kiwi_merchant_get_a2a_negotiation`、`kiwi_merchant_list_active_consultations` | `src/mcp/merchant-tools.ts` |
| Facade：报告与洽谈时间线（未配置数据源 fail-closed；非法 period/空 id 明确报错） | `src/merchant/workbench-service.ts` |
| `merchant-core` 委托与运行时装配（报告构建器 + 旁观投影注入，均绑定本实例数据目录） | `src/merchant-core/service.ts`、`src/mcp/merchant-runtime-assembly.ts` |
| 连接器声明 15 → 18 工具；单实例 OAuth 包改为模板 URL、不指向共享网关 | `integrations/hosts/workbuddy/kiwi-merchant-connector{,-oauth}/mcp.json`、`package-merchant-connector.mjs` |
| 商家运营 Skill：报告/洽谈的来源、UTC 窗口、缺失值与“不同 negotiation_id 不是多个客户” | 两个连接器包的 `skills/kiwi-merchant/SKILL.md` |
| 运营分析师：从“首发不直连”改为“已授权实例只读直连；未连接则明确说明并要导出” | `experts/kiwi-insights-analyst-0.1.2/agents/...`、`experts/kiwi-launch-team-0.1.4/agents/...`、`skills/merchant-operations-insights/SKILL.md` |

**只读边界**：新工具不在 `WRITE_TOOLS` 内，只要求 `merchant:read`；不提供金额、
底价、成本、利润、审批写入或磋商动作。`tools/call` 每次按 token scope 强制校验，
`tools/list` 只展示已授权工具。

## 3. 授权、隔离与机密

- **绑定目标不可由模型指定**：三个新工具 schema 没有 `merchant_id`、`mcp_url`、
  `instance_url` 等字段（`additionalProperties:false`）；实例地址只来自单实例装配/
  已验证绑定，不来自工具参数。
- **身份归属**：直连 OAuth 的授权主体来自实例管理员会话；配对绑定要求
  `owner_id === merchant_id`。公开地址或 WorkBuddy `sharecode` 都不能替代该授权。
- **sharecode 不是身份**：`sharecode` 是 A2A 分享链接的访问参数；实例绑定 URL 策略
  （`canonicalInstanceUrl`）要求路径恰为 `/mcp` 且**拒绝任何查询串**，因此
  `?sharecode=…` 不能作为实例身份或绑定凭据。
- **撤销与轮换**：OAuth `POST /oauth/revoke` 撤销 token 并清除记住的 consent；
  OAuth token 刷新即轮换；配对凭据单槽、重配对轮换，实例 `unpair` 吊销。
- **跨商家**：单实例固定商家；OAuth 会话商家不一致拒绝；工具只读本实例数据目录。
- **机密不进模型/日志**：token/授权码只存摘要；工具结果不含凭据；错误只回稳定文案，
  底层异常只进 stderr；本阶段未新增任何日志字段。

复用的既有验证（本阶段未改动其语义）：

- `tests/merchant-buddy/oauth-e2e.test.ts`：实例 OAuth 首绑 → 调用 → refresh 续期 →
  revoke 后拒绝；服务重启后 refresh 仍有效。
- `tests/merchant-oauth.test.ts`：read scope 过滤写工具、PKCE、撤销等。
- `tests/merchant-admin-security.test.ts`：跨商家会话授权被拒（403 access_denied）。
- `tests/merchant-gateway-tenant-registry.test.ts`：绑定/路由 URL 带查询串（含
  `sharecode`）被拒绝。

## 4. 与 Linkluck 验收目标的关系

实现支持按三条不同 `negotiation_id` 读取洽谈并比对状态（例如 SKU `10225485016481`
在 14:03、14:10、14:12 的三条记录），但**本仓库内没有真实实例的只读凭据**，
未执行真实数据比对。线上验收需要：

1. 商家在实例完成 OAuth 授权（或既有配对绑定），确认 `merchant_id` 归属；
2. WorkBuddy 侧连接器指向该实例 HTTPS `/mcp`（当前平台是否支持按用户配置待确认）；
3. 用实例工作台与 Buddy 同时读取三条洽谈，按 `negotiation_id`、相位/状态、
   SKU、数量、时间比对；金额只从有权来源核验；
4. 验证撤销后工具调用失败、另一商家凭据无法读取该实例。

## 5. 未实现 / 未验证

- WorkBuddy 平台对“固定连接器按用户指向不同实例”的支持与 OAuth 回调行为：**未实机验证**。
- 真实实例的 OAuth 直连与三条 Linkluck 洽谈的端到端比对：**未执行**。
- 平台连接器包重新生成/上传/审核：**未执行**；`platform/out/market.json` 仍是
  “首发不直连”的旧文案，需重新构建平台包后才会更新。
- 共享网关的实例代理路径（`instance-tools.ts`）保留为历史兜底，本阶段不扩展、
  不作为 WorkBuddy 私有数据通道；按“网关不碰实例”原则不应重新启用。

## 6. WP3 平台路由实测（2026-11-07）

测试账号：WorkBuddy 企业账号（商家端），本机客户端 v5.9.3；未做任何生产配置变更。

### 6.1 平台能力

- WorkBuddy“MCP 服务管理”支持**用户自定义 MCP**：粘贴 `mcpServers` JSON，
  可为每个用户配置不同的服务器 URL、headers、env、timeout。
- 没有发现“同一个已发布连接器按商家动态替换 URL”的能力；自定义 MCP 是
  每用户/每实例配置，更接近 gate **B**。

### 6.2 Linkluck 分享门禁

`linkluck-reception.app.workbuddy.host` 的 MCP/OAuth 端点都在 WorkBuddy 分享门禁后：

| 请求 | 结果 |
| --- | --- |
| `POST /mcp?sharecode=…` | 401（通过门禁，需 OAuth） |
| `POST /mcp` + `X-Share-Code` header | 401（通过门禁） |
| `POST /mcp` 无分享码 | 403 |
| `GET /.well-known/oauth-protected-resource?sharecode=…` | 200 |
| 同端点无分享码 | 403 |
| `POST /oauth/register?sharecode=…` | 201 |
| 同端点无分享码 | 403 |

WorkBuddy 的 OAuth 客户端日志显示，`beginAuthorization` 依次请求
`/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`、
`/.well-known/openid-configuration`、`/register`，**均未携带 `X-Share-Code`**，
收到 403 HTML 后解析失败（`Unexpected token '<'`），UI 从“授权中”退回“连接”。

### 6.3 本地 loopback 验证

为区分“OAuth 实现问题”与“分享门禁问题”，在本机启动临时实例
（`127.0.0.1:9199`，OAuth issuer 同为 loopback，未使用任何公网隧道）：

- `.well-known/oauth-protected-resource` → 200；
  `.well-known/oauth-authorization-server` → 200；`/oauth/register` → 201；
- WorkBuddy 自定义 MCP 指向 `http://127.0.0.1:9199/mcp` 后，完成 OAuth 授权，
  面板显示 **29/29 个工具已启用**。

结论：OAuth 直连的实现链路可用；失败原因是 Linkluck 的分享门禁，而不是 Kiwi OAuth。

### 6.4 决策与生产要求

- **A 不成立**：没有单连接器按商家动态路由的证据。
- **B 在当前 Linkluck 拓扑下被分享门禁阻塞**：MCP 请求可带自定义 header，
  但 WorkBuddy 的 OAuth 发现/注册/换 token 不带该 header。
- WorkBuddy 客户端「设置 → 数据管理 → 应用」对该应用只展示分享链接；行菜单只有
  “复制发布链接 / 下线应用 / 删除应用”，没有访问权限、公开模式或自定义域名入口。
  因此 WorkBuddy 托管当前无法提供“只放行 MCP/OAuth、继续保护工作台”的能力。
- 选定**路径 1**：把实例的 `/mcp`、`/.well-known/*`、`/oauth/*` 暴露到
  **不带分享门禁的公网 HTTPS 端点**，工作台继续留在分享门禁后。
  这需要部署侧新增域名/路由，并让 `merchant_mcp.public_url` 指向该端点；
  本阶段未执行生产变更。
- 过渡选项（不推荐作为正式方案）：实例 token 模式 + 自定义 MCP 静态
  `Authorization` header；或等待 WorkBuddy 支持 OAuth 请求携带自定义 header。

### 6.5 验证边界

- 未用 Linkluck 生产实例完成 OAuth（门禁阻塞），未读取任何商家数据。
- 本地实例的 OAuth 授权、工具列表已验证；未调用实例业务工具（测试实例无真实 ledger）。
- 测试自定义 MCP 条目与临时数据已删除，`~/.workbuddy/mcp.json` 已恢复。
