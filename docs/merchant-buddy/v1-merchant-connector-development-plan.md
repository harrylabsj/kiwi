# 商家连接器（「Kiwi 商家运营」）开发计划

状态：进行中（2026-09-17）。依据：[第 1 版设计](../v1-product-flow-and-onboarding-design.md)、[商家连接器独立发布计划](generic-merchant-connector-release-plan.md)、[平台核验记录](workbuddy-connector-platform-verification-2026-09-17.md)、[第 0 版设计](../v0-ai-cs-and-pull-subscriptions-design.md)。

**架构基线**：WorkBuddy 侧保留**买方、商家两个连接器**。买方连接器（`oc_bd73f860e3e2b5d3` / `kiwi-sourcing` / 本地 stdio / `npx @harrylabsj/kiwi@0.8.0 mcp serve`）本轮**不改动**传输、鉴权、身份或状态存储；本计划只交付**新增的商家连接器**（拟 `source=kiwi-merchant`，远程 HTTPS MCP + OAuth），它同时承载第 0 版目录能力与第 1 版自有服务路由。

## 1. 已完成

### WP1 商家入口与注册闭环（设计 §3.2 / 发布计划 §3.1）

| 交付 | 位置 |
| --- | --- |
| 一次性身份授权（schema v31）：创建/查看/决定/兑换四路由，`return_url` origin 白名单、一次性 code 只存摘要、单次消费、过期惰性清理、审计与限流 | `kiwi-catalog`：`kiwi_catalog/services/connector_identity.py`、`api/handlers/connector_identity.py`、`db/{models,migrations}.py`、`api/{route_table,fastapi_routes}.py` |
| connector token 机器凭据（未配置一律拒绝） | `kiwi_catalog/api/auth.py` |
| 门户连接确认页 `/portal/connect`：注册/登录双入口、拒绝→`access_denied`、登录/注册页 `next` 站内回跳 | `kiwi_catalog/api/handlers/portal.py` |
| 远程入口：`/oauth/*`、`/connect`、`/connect/callback`、`/mcp`、`/health`；无会话 authorize → 目录连接 → 回跳恢复原授权请求；`next`/`resume` 只接受站内 authorize 相对路径 | `src/merchant-gateway/entry-server.ts` |
| 目录身份客户端（`merchant_id` 只来自兑换结果；不跟随重定向、超时、响应逐字段校验） | `src/discovery/catalog-source/connector-identity.ts` |
| OAuth 服务器扩展：`loginPath`（缺省仍 `/admin/login`，单商家行为不变）与 `authorizationError()`（拒绝/失败按 OAuth 2.1 回跳且先校验 client/redirect_uri） | `src/auth/merchant-oauth.ts` |
| 复用 MCP 传输层（导出 `ScopedMcpTools` / `createProtocolServer`，避免第二份实现） | `src/mcp/merchant-server.ts` |

### WP2 商家目录工具与作用域凭据（设计 §3.3 / §4 执行控制）

| 交付 | 位置 |
| --- | --- |
| 商家作用域凭据（schema v32）：兑换时签发，绑定 `account_id + merchant_id + scope`，明文只返回一次、库中存 sha256，可撤销、有过期；`POST /v1/connector-identity/revoke` | `kiwi-catalog`：`services/connector_identity.py`、`api/handlers/connector_identity.py` |
| 目录商家接口接受该凭据（`Authorization: Bearer cmt_…`）：会话与凭据二选一，`merchant_id` 只来自服务端绑定；FastAPI 栈补齐 Authorization 头合并 | `kiwi-catalog/kiwi_catalog/api/handlers/merchant_publications.py`、`api/fastapi_routes.py` |
| 凭据保管：AES-256-GCM（密钥 `KIWI_GATEWAY_CREDENTIAL_KEY`，缺失即 fail-closed），入口侧 `oauth.sqlite` 每商家一行 | `src/merchant-gateway/credential-vault.ts` |
| 目录写客户端（草稿/详情/撤回；`inquiry_available=false` 作为契约不变量校验） | `src/merchant-gateway/catalog-publications.ts` |
| 五个 `kiwi_catalog_*` 工具：profile / save_draft / request_publish / status / withdraw；`request_publish` **不发布**，只返回门户确认入口 | `src/merchant-gateway/catalog-tools.ts` |
| 入口按已验证主体逐请求构造工具束（`toolsFor`），连接成功即写入凭据保管 | `src/merchant-gateway/entry-server.ts` |

### WP3 入口 CLI 与部署配置（设计 §3.2 / 发布计划 §2）

| 交付 | 位置 |
| --- | --- |
| `kiwi merchant gateway serve`：装配 `oauth.sqlite`、OAuth 服务器、会话、目录身份客户端、凭据保管、目录工具与实例工具；`--check` 只做校验 | `src/merchant-gateway/cli.ts`、`src/cli.ts`、`src/product-cli.ts` |
| **TLS 边界**：公网入口必须 https（loopback http 仅限开发）；监听非 loopback 必须提供 `--tls-cert/--tls-key`（本进程直接终止 TLS）或显式 `--trusted-proxy`（反向代理终止），否则**拒绝启动** | 同上 + `entry-server.ts` 的 https 支持 |
| **可配置项**：`--source`（缺省 `kiwi-merchant`）、`--public-url`、`--callback-uri`、`--no-loopback-callback`、`--connector-token-env`、`--credential-key-env` | 同上；回调策略见 `merchant-oauth.ts` 的 `OAuthCallbackPolicy` |
| **凭据分工**在启动摘要中显式打印（用户 OAuth token / connector token / 商家目录凭据 `cmt_` / 实例内部凭据 / 加密密钥），并列出功能开关 | `cli.ts` 的 `printReadiness` |
| connector token 缺失 → 拒绝启动；**凭据加密密钥缺失 → 可启动但关闭依赖加密存储的功能**（目录工具、vault 凭据实例）并告警 | `cli.ts` |

### WP4 第 1 版实例路由（第一增量：注册表、凭据来源、路由工具）

| 交付 | 位置 |
| --- | --- |
| 注册表 URL 策略：非 loopback 必须 https（明文 http 仅限 loopback）、复用 A2A 出站守卫（拒绝 userinfo/保留主机名/字面保留 IP）、路径恰为 `/mcp`、loopback 必须显式端口 | `src/merchant-gateway/tenant-registry.ts` |
| 内部凭据来源二选一：环境变量（`token_env`）或**加密保管库**（`credential_kind: "vault"`，键 `instance:<merchant_id>`）；两者同时给出即配置错误 | 同上 + `credential-vault.ts` |
| 租户配置解析（`--tenant-config` JSON），畸形一律拒绝、不默认填充 | 同上 |
| 实例工具：工具清单**从实例现取**（经 `mcp-proxy` 按令牌 scope + allowlist 过滤，TTL 60 秒缓存），调用经代理转发；实例不可达/未配对/凭据缺失时第 1 版工具不可见，**第 0 版不受影响** | `instance-tools.ts`、`tool-bundle.ts` |
| 入口按已验证主体组合第 0 版与第 1 版工具束 | `cli.ts` |

**验证**：`kiwi-catalog` `pytest` 759 项通过 + `ruff` 全绿；`kiwi` `vitest` 2375 项 / 185 文件通过 + `tsc --noEmit` + `eslint --max-warnings=0` 全绿；跨仓验收脚本 15/15 通过（见 WP8）。新增测试：`tests/test_connector_identity.py`（24 项）、`tests/merchant-gateway-entry.test.ts`（8 项）、`tests/merchant-gateway-catalog-tools.test.ts`（12 项）、`tests/merchant-gateway-cli.test.ts`（17 项）、`tests/merchant-gateway-instance-tools.test.ts`（11 项）。

### WP8 跨仓端到端验收（真实 kiwi-catalog + 网关 + 桩商家实例）

`scripts/v1-merchant-connector-acceptance.sh`（配套 `scripts/lib/merchant-instance-stub.mjs`）：起**真实 kiwi-catalog 本地实例**（临时库、loopback、console 邮箱验证）+ 网关入口 + 桩商家实例，跑完 15 项断言并全部通过：

| 断言 | 说明 |
| --- | --- |
| 商家身份闭环 | 无会话 authorize → `/connect` → 目录注册/验证/登录 → 门户确认（`decision=approve`）→ 一次性 code → 网关兑换 → 入口会话 → 授权同意页 → 授权码 → token |
| 工具清单 | 第 0 版 5 个 `kiwi_catalog_*` **+** 已配对实例的 `kiwi_merchant_*`（清单从实例现取，非硬编码） |
| 草稿私有 | 工具写入的草稿不出现在 `/v1/merchant-publications/search` |
| 模型不能自批发布 | `kiwi_catalog_request_publish` 后状态仍为 `draft` 且搜索仍为空 |
| 商家确认才公开 | 门户确认发布后 `publication_id` 不变、可被公开搜索命中，`source_kind=merchant_declared`、`inquiry_available=false` |
| 第 1 版路由 | 实例工具调用带该商家内部凭据打到**该商家的**实例（桩记录调用并校验 Bearer） |
| 租户隔离 | 未配对实例的商家 B：第 0 版可用、无实例工具、桩从未收到 B 的请求 |
| 未认证拒绝 | 无令牌 `/mcp` 返回 401 且带 `resource_metadata` 指引 |
| 自助绑定与解绑 | 商家在 `/instance` 页面提交地址 + 内部令牌 → 探活（打桩实例的 initialize/tools/list）→ 工具清单出现实例工具；解绑后实例工具消失、第 0 版不受影响；页面不回显令牌 |

可重复执行（连续多次通过，端口预检防止复用残留进程，退出后无残留进程与目录）。

**本地冒烟**（loopback 开发形态，**非**生产联调）：`kiwi merchant gateway serve --public-url http://127.0.0.1:9299 --check` 通过；实起进程后 `/health` 200、`/.well-known/oauth-authorization-server` 返回 source 派生的端点与 scope、无 token 调用 `/mcp` 返回 401；`--tenant-config` 指向 1 个实例时就绪摘要显示「✓ 第 1 版实例路由（已注册 1 个商家实例）」。

**外部核验前不做的事**：不标记生产联调通过、不切换 `https://merchant.kiwi.harrylabsj.com` 线上入口、不提交连接器包。

## 2. 待办

### WP4 余项（设计 §4.2–§4.5 / 发布计划 §3.3）

已完成（第一期自助绑定，安全设计见 [配对与认领安全设计](merchant-instance-pairing-design.md)）：

| 交付 | 位置 |
| --- | --- |
| 绑定即控制权证明：地址策略（与注册表同口径）+ 探活（initialize & tools/list，拒绝重定向/401/非 MCP 端点）——三者同时成立才保存 | `src/merchant-gateway/instance-registration.ts` |
| `/instance` 页面（需商家 OAuth 会话）：绑定/解绑；令牌只经表单提交、加密落库、页面与日志均不回显 | `entry-server.ts`、`cli.ts` |
| 动态注册表：静态配置未命中时按 `merchant_id` 查商家自绑实例；解析时重校地址策略 | `tenant-registry.ts` |
| 解绑：删除地址与凭据；目录公开资料与买家关注不受影响 | `instance-registration.ts` |

剩余（未完成）：

- **第二期配对码与凭据轮换**：实例侧一次性配对码（商家不再接触长期令牌）、网关签发并推送/轮换实例凭据、实例身份声明比对（防误配）、mTLS——需改商家实例产品面，取舍见设计文档 §4。
- **请求时 DNS/IP 钉住**：当前只用 `assertSafeTargetUrl`（静态）+ 私网字面 IP/保留主机名拒绝；钉住未实现，因此**不得宣称已支持异地自托管**。
- 能力探测（版本/能力上报）与离线恢复演练。
- 三方联调：两台独立商家实例 A/B 的真机隔离验证。

### WP5 商家连接器包与上架

已完成（本地，未提交平台）：

| 交付 | 位置 |
| --- | --- |
| 连接器包：`connector-meta.json`（source `kiwi-merchant`、OAuth、无 Authorization 头）、`mcp.json`（指向网关 HTTPS 入口，静态声明 5 个第 0 版目录工具）、`icon.svg`、README（与单实例包的区分、提交前确认清单） | `integrations/hosts/workbuddy/kiwi-merchant-gateway-connector/` |
| 打包/校验脚本：meta/mcp/icon 合法性、url 必须 https + `/mcp` + **不得**落在商家自有实例域名、tools 声明与实现同名、包内无疑似凭据；`--check` 与 `--out <zip>` | `integrations/hosts/workbuddy/package-gateway-connector.mjs` |
| 契约锁定：声明与实现（描述、inputSchema）**全等**比对，随 CI 跑；source 与入口 CLI 缺省一致；OAuth 回调与买方 `kiwi-sourcing` 分离 | `tests/workbuddy-gateway-connector.test.ts` |

产物：`/tmp/kiwi-merchant-gateway-1.0.0.zip`（3 文件 9KB，本次为验证用；正式产物在提交前重新生成）。

剩余（外部阻塞，见 §3）：

- 核对 `kiwi-merchant` source 唯一性与新平台 ID；确认入口域名切换方案后，将 ZIP 上传平台解析 → 预览 → 审核 → 记录新平台 ID → 配置给商家 Buddy（采购专家继续引用买方原 ID）。
- Buddy 应用：首页四类入口 + 状态文案（设计 §5 状态表）+ 场景胶囊。
- 预览实测：绑定实例后新增工具是否需要 Buddy 侧重连/刷新才可见。

### WP6 7×24 与公开状态

- 商家服务由 runtime 常驻，关闭 Buddy 后仍接待（验收）。
- 服务离线时买方专家不再显示「可实时询价」，公开资料仍可查；恢复后自动回到实时能力。当前买方侧 `inquiry_available` 只由 Agent Card 是否存在决定，**需要新鲜度/存活信号**才能满足该要求。

### WP7 买方侧独立增量（不属商家交付依赖）

- 公开资料发现、FAQ 问答、关注/更新拉取等买方功能按**独立兼容版本**交付，保持 stdio 与既有九工具契约；采购专家不依赖新增商家连接器。
- 历史调查结论（买方 stdio → 远程 OAuth 的平台兼容性）**不再是商家上架阻塞项**；如未来重新决定买方远程化，另行评审用户隔离与旧任务迁移。

## 3. 需要平台/人工确认的外部事项

1. 新增商家 source 唯一性与新平台 ID（发布计划 §5）。
2. 商家连接器的首次绑定/注册回跳、OAuth 窗口形态与工具可见性（设计 §8.1/§8.2）。
3. 商家包的真实 HTTPS 入口与 OAuth 回调配置。
4. 商家 A/B 的服务归属由服务端校验（技术验收，非平台审批）。

## 4. 明确不做

- 修改买方连接器的传输、鉴权、身份或状态存储；把买方包迁移为远程 OAuth。
- 把 Veyquo 单实例包当作通用商家入口上架。
- 让商家连接器承载买方工具，或让买方连接器承载商家私有运营工具。
- 商家主动推送、商家获取关注者身份；公布未发布草稿、私有任务或价格底线。
