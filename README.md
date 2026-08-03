# Kiwi

Kiwi 是独立的 A2A 电商磋商 Agent Runtime：嵌入 Pi（`@earendil-works/pi-agent-core` / `pi-ai`）负责“思考和调用工具”，shopping-cli 负责“电商语义、规则、写入和审计”。两者只通过版本化 JSON 契约和 HTTP API 连接。

当前版本实现 **M0（冻结契约）+ M1/M2（双角色单轮）+ M3（前台轮询、心跳与 stale 恢复）+ M4（managed-local 产品编排）**：buyer 与 merchant 共用同一个 runtime（profile 决定角色），支持 `--once` 单轮与前台串行轮询，全部业务访问走 shopping-cli 的真实 `shopping.negotiation/0.1` 权威 API；`kiwi init/up/status/logs/down` 提供单实例产品生命周期管理。

## 边界

- 磋商只形成**非约束性共识**：不创建订单、不支付、不锁库存（`stock.reserved` 恒为 `false`，capability `orders` 恒为 `false`）。
- 两个角色的模型都只能看到两个工具：`get_negotiation_snapshot`（只读、绑定会话）和 `submit_negotiation_decision`（唯一写意图、终止本轮）。不存在文件、Shell、编辑、搜索、任意 HTTP 或动态安装工具。
- `beforeToolCall` 做 allowlist、参数大小上限和 conversation/message 绑定校验；**权威策略门在 Commerce API 侧**。
- Marketplace conversation 是权威记忆；不持久化 Pi session，重启后从 Marketplace 恢复。
- 所有业务访问走 shopping-cli HTTP API；不导入 Python 模块、不直连 SQLite、不调用 `pi` CLI、不依赖 `pi-coding-agent`/`pi-tui`。

## 依赖

- Node.js >= 22
- `@earendil-works/pi-agent-core` 精确锁定 `0.83.0`
- `@earendil-works/pi-ai` 精确锁定 `0.83.0`

## 快速开始（managed-local 产品栈）

```bash
npm install
npm run build

# 创建自包含实例（profiles 只含环境变量名，绝无 secret；--fake 用确定性 demo 模型）
kiwi init --dir ./my-instance --fake            # 或 --shopping-cli-src <path> 显式指定
kiwi up --dir ./my-instance                     # 启动 shopping-cli gateway + buyer/merchant agents
kiwi status --dir ./my-instance                 # 结构化 JSON：gateway 健康 + 各进程 verified/running
kiwi logs --dir ./my-instance --lines 50        # 按进程标注、脱敏的有界 tail
kiwi down --dir ./my-instance                   # 只停本实例校验过的进程（幂等）
```

安全模型：`up` 通过内部 child-runner 启动每个进程，wrapper argv 中含每次进程独立的随机 nonce；`status`/`down` 只在 instance id + uid + 活动进程 argv nonce + 命令指纹全部匹配后才发信号，绝不使用 pgrep、进程名模糊匹配或按端口杀进程；`down` 先 SIGTERM、有界等待、仅对仍可验证的自有 wrapper 才升级 SIGKILL，无法验证的进程只报告、绝不触碰。实例状态：`kiwi.stack.json`（0600）+ `run/`（0700，原子写 manifest）；`init` fail closed，已有 Kiwi 状态或目标文件存在时拒绝，绝不覆盖用户文件。`up` 在留下任何后台进程前校验 config/profile/所需环境变量，部分失败只回滚自己创建的进程；`up`/`down`/`status` 均幂等。managed-local 保持 HTTP 隔离：agent 不 import Python、不碰数据库，supervisor 仅以产品生命周期职责启动 `python -m shopping_cli.api.server`（argv 数组，无 shell 字符串）。`connected` 模式（连接外部部署的 gateway）在 0.1.0 不由 Kiwi 管理，`up` 会明确报错而不是假装支持。

## 快速开始（单 agent）

```bash
npm install
npm run build

# 只读诊断（不做任何磋商写入）
kiwi doctor --profile examples/profiles/merchant.fake.yaml

# 单轮：claim -> snapshot -> model -> decision -> policy gate -> complete
kiwi agent run --profile examples/profiles/merchant.fake.yaml --once
kiwi agent run --profile examples/profiles/buyer.fake.yaml --once

# 前台串行轮询（同一 profile 永不并发 turn；SIGINT/SIGTERM 干净退出，退出码 0）
kiwi agent run --profile examples/profiles/merchant.fake.yaml
```

Secret 只允许环境变量引用：profile 里的 `commerce.token_env` / `model.api_key_env` 是环境变量名，不是值。`kiwi doctor` 会扫描 profile 中疑似内联的 secret。

`model.provider: fake` 使用内置的确定性 fake 模型（merchant 按牌价报价；buyer 在私有约束内接受或转人工），不需要任何模型凭据，适合本地冒烟和 CI。真实模型通过 pi-ai 接入（OpenAI / Anthropic / Google / OpenRouter / OpenAI 兼容端点，见 `model.provider` / `model.api` / `model.base_url`）。

## Profile 与私有策略

同一个 runtime 用 profile 区分角色（`role: buyer | merchant`）。角色与私有策略严格绑定、互斥且 fail closed：

- `role: merchant` 必须有 `merchant_policy`（`min_unit_price_private`、`max_auto_discount_percent`、`inventory_source`、`quote_ttl_seconds`、`auto_negotiate`、`human_review_on`），不得有 `buyer_policy`。
- `role: buyer` 必须有 `buyer_policy`（全部必填）：`target_skus: string[]`、`quantity: 正整数`、`max_total_price_private: finite >= 0`、`acceptable_eta_latest: 带时区 RFC3339`、`required_after_sales_terms: string[]`、`auto_negotiate: boolean`、`human_review_on: string[]`，不得有 `merchant_policy`。
- 任何未知字段（包括 policy 内）都会被拒绝；NaN/Infinity 与不带时区的时间一律 fail closed。

**buyer 本地私有策略门**（`src/runtime/buyer-policy.ts`）：`max_total_price_private` 等私有阈值只存在 Kiwi 进程内，服务端永远看不到也不校验。submit 工具在调用网关之前本地拦截：

- proposal 总价（单价 × 数量 + 配送费）超过 `max_total_price_private`；
- proposal 配送 `eta_end` 晚于 `acceptable_eta_latest`；
- proposal 缺少 `required_after_sales_terms` 中的条款；
- `public_message` 出现预算类措辞（“我的预算 / 最高预算 / 内部预算 / budget …”），视为泄露私有预算。

本地拒绝以 `rejected_retryable` 形态返回给模型，可在 `max_retries` 内修复；恰好等于预算的普通报价（不称其为预算）不受影响。错误、日志与公开消息中绝不包含私有阈值数值。merchant 侧的底价/泄露门在服务端（shopping-cli），Kiwi 不复制。

## 运行模式与退出码

- `--once`：至多处理一条已 claim 消息，打印一行 JSONL turn report 后退出。
- 不带 `--once`：前台串行轮询。`no_work` 等待 `poll_interval_seconds`；暂时性错误（transient/rate limit）按指数退避（上限 60s）后继续；每个 turn 输出一行 JSONL report，不含 secret 或私有策略值。
- SIGINT/SIGTERM：当前 turn 收到 AbortSignal 并 abort Pi；已 claim 但未 accepted 的消息一律 **abandon**（绝不 complete），可被其他 worker 重领；已 accepted 的决策绝不回滚（claim 正常 complete）。随后前台循环干净退出，退出码 0。

## 可靠性：stale 恢复与心跳（M3）

- **崩溃恢复**：每个 turn（once 与前台模式）在找活之前先调用 `POST /negotiation/claims/abandon-stale`，abandon **本身份**（token 推导）超过 `STALE_CLAIM_TTL_SECONDS = 300s` 未更新的 `processing` claim；被 abandon 的 claim 可重领（attempts 递增）。顺序保证：先恢复、后心跳，绝不复活 stale 工作。merchant agent daemon 的 TTL 机制仍在服务端兜底。
- **心跳**：claim 存活期间 runtime 每 `HEARTBEAT_INTERVAL_MS = 60s`（远低于 300s TTL）调用 `POST /negotiation/claims/heartbeat` 刷新 `updated_at`，健康的长 turn 不会被误判为 stale。心跳不重叠（上一次未返回则跳过）、失败只计数不失败 turn、turn 结束时定时器与在途请求一并清理；`heartbeat.beats/failures` 写入 JSONL turn report。
- 两个端点都只作用于 token 推导的本身份：buyer 仍是 conversation-scoped，无法触达其他 buyer 或 merchant 的 claim；`ttl_seconds` 在服务端严格校验（默认 300、上限 86400，bool/小数/非正值/超限一律 400）。

| 码  | 含义                                          |
| --- | --------------------------------------------- |
| 0   | 成功、无待处理消息、already_claimed、信号退出 |
| 2   | 配置错误                                      |
| 3   | Commerce Gateway 认证/权限错误                |
| 4   | 模型不可用                                    |
| 5   | 策略结果需要人工处理                          |
| 10  | 暂时性错误/超时，外部监督器可重试             |

## 契约：`shopping.negotiation/0.1`

冻结的 JSON Schema 在 `contracts/shopping.negotiation/0.1/`（与 shopping-cli 侧逐字节一致）：

- `snapshot.schema.json` — 角色裁剪后的权威磋商快照
- `decision.schema.json` — `submit_negotiation_decision` 的唯一写意图
- `policy-result.schema.json` — 策略门结果（`accepted` / `rejected_retryable` / `human_required`）
- `capabilities.schema.json` — CommerceGateway 能力与协议声明（`orders` 恒为 `false`）

所有对象层 `additionalProperties: false`。跨语言 fixtures 在 `fixtures/negotiation/`，同时被两侧校验：

```bash
npx vitest run tests/contracts.test.ts        # TypeScript / Ajv
python3 scripts/validate_fixtures.py          # Python / jsonschema
```

Pi 工具的参数 schema 由冻结的 decision schema 内联 `$defs` 后生成，模型面契约不会漂移。

## CommerceGateway / CommerceClient

`src/commerce/types.ts` 定义稳定接口：`health` / `getCapabilities` / `listPendingMessages` / `claimMessage` / `getNegotiationSnapshot` / `submitNegotiationDecision` / `completeClaim` / `failClaim` / `abandonClaim`。

`HttpCommerceClient` 直连 shopping-cli 的真实权威端点：

| 方法                         | 端点                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `getCapabilities`            | `GET /capabilities`（内层 `capabilities`，frozen schema 校验）                          |
| `listPendingMessages`        | `GET /negotiation/pending-messages`（角色/owner 由 token 服务端推导，客户端不传不信任） |
| `claimMessage`               | `POST /negotiation/claims`（只 `conversation_id`/`message_id`/`idempotency_key`）       |
| `getNegotiationSnapshot`     | `GET /negotiation/snapshot?conversation_id=&message_id=`                                |
| `submitNegotiationDecision`  | `POST /negotiation/decisions`（`{idempotency_key, decision}`）                          |
| `complete/fail/abandonClaim` | `POST /negotiation/claims/{complete,fail,abandon}`                                      |
| `heartbeat`                  | `POST /negotiation/claims/heartbeat`（`{message_id?}`，只刷新本身份 processing claim）  |
| `abandonStaleClaims`         | `POST /negotiation/claims/abandon-stale`（`{ttl_seconds?}`，只恢复本身份 stale claim）  |

capabilities / snapshot / policy_result 响应一律用 Kiwi Ajv frozen schema **fail closed** 校验：信封形状不对、缺内层对象、字段类型错误都归类为 `validation` 错误，绝不信任。HTTP 状态到 `auth` / `not_found` / `conflict` / `rate_limit` / `validation` / `transient` 的映射保留；网络错误与超时归为 `transient`。

`FakeCommerceClient` 是确定性内存实现（buyer/merchant 双角色、可共享同一 marketplace 状态交替磋商），含策略门子集：schema、next_actor、claim 绑定、SKU/库存、merchant 私有底价、售后 policy ref、泄露扫描、幂等提交、no-order 边界。buyer 私有预算不在其中——与真实网关一致，它只在 Kiwi 本地门里。

幂等键约定：`agent_id:message_id:protocol_version`；submit 使用内容寻址键（`…:submit:<sha256前16位>`），相同参数重放返回已存结果，修复后的决策得到新键。

## 真实集成（跨进程 E2E）

`scripts/e2e-local.sh` 启动真实 shopping-cli HTTP API（隔离临时目录与数据库，只杀自己启动的 PID、只删自己的临时目录），用真实 merchant token 与 conversation-scoped buyer token 分别运行 Kiwi merchant/buyer fake `--once`，验证：buyer 提问 → merchant counter → buyer `accept_nonbinding`；两个 claim 都 `processed`；恰好 3 条消息；`next_actor` 正确；无重复写入；库存不变；数据库不存在任何 order/payment/reservation 表。端口默认自动选择空闲 loopback 端口（`PORT` 环境变量可显式覆盖）；buyer/merchant profile 在临时目录按本次 base URL 生成，不修改仓库内的示例 profile，secret 只走环境变量。

```bash
bash scripts/e2e-local.sh   # SHOPPING_CLI_SRC 默认指向 ../shopping-cli，PORT 可选
```

该脚本是可选验收工具，不是 runtime 依赖。

## 测试与质量

```bash
npm run lint            # eslint --max-warnings=0（0 error / 0 warning）
npm run typecheck       # tsc --noEmit（strict）
npm run test            # vitest，183 个测试，fake model + fake marketplace + 注入 fetch/sleeper/signal + stub 进程，无外部依赖
npm run build           # tsc 构建到 dist/
npm run verify:package  # 生产包冒烟：npm pack -> 临时目录 npm install --omit=dev -> 运行 kiwi --version 并 import schemas/runtime
npm run verify          # 以上全部
```

覆盖：profile 严格校验（未知字段、NaN/Infinity、runtime 上限、merchant_policy 全字段、**buyer_policy 全字段必填/类型/时区/角色互斥**、model.api/thinking_level fail closed）、base_url 安全、冻结契约 fixtures、`beforeToolCall` 越权、claim/complete/fail/abandon 与重试、提交幂等、max_retries 提交预算、确定性 turn timeout、HttpCommerceClient 全量单测（真实端点路径/方法/body、Ajv fail closed、Bearer、双方 pending、请求体无 merchant_id/role/order/payment/reservation 字段）、**buyer 全路径**（accepted、预算恰好等于上限放行、超预算/超 ETA/缺售后条款/预算措辞泄露的本地拦截且不含数值、修复、human_required、提交预算、跨会话 guard、确定性 fake buyer）、**前台轮询**（no_work 等待、有界退避、信号中止 abandon 且不 complete、accepted 不回滚、无双重 claim、maxTurns）、**M3 可靠性**（双角色 stale 崩溃恢复→abandon→reclaim、恢复先于心跳、心跳防 stale、transient 心跳失败不失败 turn、心跳不重叠/定时器不泄漏、abort 后无残留、buyer/merchant 身份隔离、两端点严格形状校验）、**M4 产品编排**（stack config 严格解析、init 不覆盖/拒绝宽目录/0600/0700 权限、manifest 原子写与 nonce/PID 验证、信号转发 exit code、不可验证进程只报告不杀、up/down/status 幂等、env 先验与部分失败回滚、日志脱敏/有界 tail/路径包含、sentinel 存活、CLI 参数校验）。另有 `scripts/e2e-supervisor.sh` 真实 managed-local 全链路验收。

## 已知限制

- **connected 模式不由 Kiwi 管理**：`kiwi up` 只支持 managed-local；连接外部部署 gateway 时直接用 `kiwi agent run` / `kiwi doctor`。
- **真实模型 smoke 未纳入 CI**；CI 主路径只用确定性 fake model。
- supervisor 单实例单目录：一个实例目录对应一个 gateway + 双 agent；多实例用多个 `--dir`。wrapper 仅在 SIGTERM 有界等待失败后才升级 SIGKILL；SIGKILL 直接命中 wrapper 时其子进程可能成为孤儿（最后手段，正常 down 不会发生）。日志无轮转，长时间运行需外部清理。
- `human_required` 结果会让 claim 以 `processed` 结束（升级即本轮职责完成），避免无限重试。
- turn timeout 是确定性状态：超时的 claim 一律 `fail`（绝不 complete），进程以可重试退出码 10 退出，由外部监督器重试。
- `profile.runtime.max_retries` 的语义是“首次提交之外允许的修复次数”，工具层强制每轮提交数 ≤ max_retries + 1（buyer 本地拦截也计入）；超预算会阻止写网关并以可审计失败结算。
- buyer token 是 conversation-scoped：buyer 的 pending-messages 只覆盖其绑定会话；多会话需要每会话一个 token（shopping-cli 0.1 限制）。
