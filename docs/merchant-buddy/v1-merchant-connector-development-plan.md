# 商家连接器（「Kiwi 商家运营」）开发计划

状态：进行中（2026-09-17）；**2026-09-18 收窄为只交付第 0 版**（见下方状态说明）。依据：[第 1 版设计](../v1-product-flow-and-onboarding-design.md)、[商家连接器独立发布计划](generic-merchant-connector-release-plan.md)、[平台核验记录](workbuddy-connector-platform-verification-2026-09-17.md)、[第 0 版设计](../v0-ai-cs-and-pull-subscriptions-design.md)。

> **2026-09-18 收窄。** 按[「网关不碰实例」](merchant-connector-deployment.md)原则（部署说明 §0），
> 网关只做第 0 版目录能力，商家实例独立运行、与网关无连接；买家经目录发现后直接与实例做 A2A。
> 因此 **WP4（第 1 版实例路由）及其相关条目当前不采用**——实现代码保留作兜底，但不再作为交付与
> 验收对象。阅读本文时请以 §1「已完成」中的**第 0 版部分**为准；涉及 `kiwi_merchant_*` 工具清单、
> 实例配对、租户路由的段落属于保留形态，**不要按它们继续开发或验收**。

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
| 六个 `kiwi_catalog_*` 工具：profile / merchant_stats / save_draft / request_publish / get_publication / withdraw；`request_publish` **不发布**，只返回门户确认入口；`merchant_stats` 只回匿名聚合（关注总数 + 浏览量 + 各资料表现，无身份、无名单、无群发通道）；`get_publication` 返回可编辑内容，供文案改写前读原文 | `src/merchant-gateway/catalog-tools.ts` |
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

**验证**：`kiwi-catalog` `pytest` 759 项通过 + `ruff` 全绿；`kiwi` `vitest` 2375 项 / 185 文件通过 + `tsc --noEmit` + `eslint --max-warnings=0` 全绿；跨仓验收脚本 21/21 通过（见 WP8）。新增测试：`tests/test_connector_identity.py`（24 项）、`tests/merchant-gateway-entry.test.ts`（8 项）、`tests/merchant-gateway-catalog-tools.test.ts`（12 项）、`tests/merchant-gateway-cli.test.ts`（17 项）、`tests/merchant-gateway-instance-tools.test.ts`（11 项）。

### WP0 买方工具契约冻结（已发布连接器不受影响）

| 交付 | 位置 |
| --- | --- |
| 已发布买方连接器（`oc_bd73f860e3e2b5d3` / `kiwi-sourcing`，本地 stdio）九个工具的**名称与 inputSchema** 逐字冻结为基线 | `tests/fixtures/buyer-tool-contract.json` |
| 契约锁定测试：任何改动都会失败并指出被改的工具；新增能力必须以增量工具交付（第 0 版关注三件套即先例）；采购专家仍依赖原连接器 ID；商家连接器包不声明买方工具、不指向买方 source | `tests/buyer-tool-contract.test.ts` |

### WP8 跨仓端到端验收（真实 kiwi-catalog + 网关 + 桩商家实例）

`scripts/v1-merchant-connector-acceptance.sh`（配套 `scripts/lib/merchant-instance-stub.mjs`）：起**真实 kiwi-catalog 本地实例**（临时库、loopback、console 邮箱验证）+ 网关入口 + 桩商家实例，跑完 21 项断言并全部通过：

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
| 一次性配对码与凭据轮换 | 真实 CLI 生成码 → 网关 `POST /instance/pair` 兑换（桩用真实配对实现）→ 实例工具恢复**且网关改用配对凭据调用实例**；同一码重用被拒 |
| 出站钉住 | 单元测试覆盖：私网/保留段、公网域名解析到 loopback、多地址混入私网、解析失败/空结果一律拒绝；适配层 Host 头与路径、不跟随重定向、AbortSignal 生效 |
| 能力探测 | 粘贴绑定后绑定页显示实例自报版本（`merchant-instance-stub-A v0.0.0`）与探测到的工具数 |
| 离线恢复 | 实例重启后凭据仍被接受、网关重启后目录与实例能力均可用（无需重新配对/连接） |
| A/B 两实例隔离 | 两个独立实例各自配对、各自路由；A 的调用不增加 B 实例的请求计数 |
| 7×24 独立性 | 网关停止期间商家实例仍直接对外服务（不依赖 Buddy 窗口） |

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
| 一次性配对码（§8.4 第二期）：实例侧 `kiwi merchant mcp pair`（10 分钟 TTL、单次、只读可抄、只存摘要）+ `POST /pairing/redeem`；兑换时实例**新签**配对凭据（单槽、可轮换、可吊销，`unpair`），网关加密保存并使用；未升级实例仍可粘贴令牌 | `src/auth/merchant-pairing.ts`、`merchant-server.ts`、`entry-server.ts` |
| token 模式也挂载写操作确认页：网关路由需要静态内部令牌，商家仍能批准写候选（原先只有 OAuth 模式有 `/admin/*`，两种要求无法同时满足） | `src/cli.ts` |

剩余（未完成）：

- ~~网关签发内部凭据与自动轮换~~ **已决定不做**（最小授权：凭据由实例签发与持有；轮换 = 商家重配对，吊销 = 实例侧 `unpair`）。替代已实现：配对凭据单槽轮换 + 静态令牌并存。
- **mTLS**：**决定不做**（理由见配对设计 §4：钉住出站 + 实例签发可轮换凭据已覆盖主要风险，双向证书的签发/分发/轮换/吊销成本更高）。
- ~~请求时 DNS/IP 钉住~~ **已实现**：解析一次 → 校验（含公网域名解析到 loopback）→ 按该 IP 建连（Host/SNI 仍为主机名）；实例调用（探活、配对兑换、工具转发）默认走钉住出站。
- ~~能力探测（版本/能力上报）~~ **已实现**：绑定前实测（配对路径用兑换到的凭据调 `tools/list`，用不了即拒绝绑定），记录实例自报名称/版本与工具数并在绑定页展示。
- ~~离线恢复演练~~ **已实现**：跨仓脚本覆盖实例重启与网关重启（凭据落盘，无需重新配对）。
- ~~两台独立实例 A/B 真机隔离联调~~ **已覆盖**：跨仓脚本用两个独立实例（A/B 各自配对、各自路由、A 的调用不达 B）。**仍未覆盖**：真实公网部署下的端到端（依赖部署环境）。

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

### WP6 7×24 与公开状态（已完成）

| 侧 | 交付 |
| --- | --- |
| 商家（kiwi） | A2A 节点注册成功后**立即心跳一次**再进入循环（否则刚上线的商家要等满一个间隔才被判在线，而注册时的验证结论可能是 stale）；`kiwi` 侧缺省 300s（`KIWI_AGENT_HEARTBEAT_SECONDS=0` 关闭），带 owner 凭据调 catalog `/heartbeat`；失败写 stderr 但不致命（读侧会因超时判离线，fail-visible）。缺 owner 凭据时注册退回匿名自助、心跳 403——这是预期的 fail-closed |
| 目录（kiwi-catalog） | `POST /v1/agent-catalog/agents/{id}/heartbeat`：轻量"我还在线"（**不重新抓取资料、不消耗验证队列**），刷新 `last_seen_at` 并把 active 商家复活为 fresh；治理状态优先（suspended/rejected 不因心跳复活） |
| 目录（读时） | `freshness_state` 按 `last_seen_at` + `KIWI_CATALOG_AGENT_FRESH_TTL_SECONDS`（缺省 900s）**读时派生**：只降不升；无 `last_seen_at` 的旧数据保持 fresh（避免升级即全线离线）。不改存储态，因此上线后心跳一次即恢复 |
| 买方（kiwi） | `inquiry_available` 要求 agent 新鲜（`stale`/`unreachable` → false，并给出"服务当前离线…公开资料仍可查"的降级说明）；RFQ 硬门新增 **`merchant_offline`** 错误码（与 `merchant_inquiry_unavailable` 区分：一个是从未开通，一个是暂不在线），不产生任务；工具描述与三个宿主 SKILL 文档同步 |

**验收**：目录侧 8 项（派生只降不升/兼容、心跳刷新与治理优先、鉴权 fail-closed）、买方 3 项（stale/unreachable 降级、契约缺字段 fail-closed、RFQ 离线门）、心跳客户端 3 项（端点/凭据/不跟随重定向/失败可见）；跨仓脚本新增「网关停止期间商家实例仍对外服务」1 项（共 21 项）。

**真机验证**（本地 catalog + 真实 `kiwi merchant start` A2A 节点，TTL 60s）：

```
商家上线（注册 + 立即心跳）      → freshness_state=fresh
模拟离线（last_seen 老化 > TTL） → freshness_state=stale（存储态仍 fresh，读时降级）
商家重新上线（心跳一次）          → freshness_state=fresh
```

**未覆盖**：买方 MCP 侧的端到端（真实节点 + 本地 catalog + 买方 `kiwi mcp serve` 三者联跑，验证 RFQ 返回 `merchant_offline`）——买方侧逻辑由单元测试覆盖（stale/unreachable 降级、缺字段 fail-closed、RFQ 离线门），脚本化留待与买方侧独立增量一起做。

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
