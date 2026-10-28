# Changelog

## v0.12.11 — 2026-10-28

- **成交入口永远不下发**（端到端验证到交接才发现）：商家只在 `product.stock` 与 `product.source_evidence` 同时存在时才把 `handoff_destination` 放进报价；而 shopping-cli 的商品读接口从不投影 `source_revision`/`observed_at`，于是每个 shopping-cli 商家的报价都被标成 `needs_confirmation`，买家走到 `kiwi_handoff` 只会得到 `必须提供 url`。shopping-cli 3.2.9 的商家读现在返回 `source_evidence`（公开投射仍剥离），kiwi 解析后交给 handler——守卫本身没有放宽。
- **发布后的 registry 校验误报红**：npm 对刚发布的包会显示「being processed and may take a few minutes」，期间按版本查询返回 E404（实测 merchant-cloud 0.12.10 用了约 25 分钟）。原来只做 4 分钟的传播重试，导致 `Verify npm and PyPI downloads` 长期假红。重试预算抬到约 20 分钟；摘要不匹配仍然立即失败。

## v0.12.10 — 2026-10-28

- **商家对每一笔询价都回 `field_unsupported`**（端到端测试发现）：报价 handler 对单位做严格比较（不映射同义词），而 shopping-cli 的 `products` 表没有单位列，`GET /products/{sku}` 也不返回单位——于是所有 shopping-cli 商家对任何 RFQ 都在 0.0 秒内拒绝，商家侧 `conversations`/`messages` 一直是空的。新增 `commerce.default_unit`（可选，短单位 token）：商品源没声明单位时用它，未配置则保持 fail-closed。严格比较本身不变。
- **买家把商家的明确拒绝当成"结果未知"**：商家的结构化拒绝（`data: {decline:true, reason_code}`）没有 KNP 信封，恢复路径会轮询到超时再报「可能已执行」，既不准确也诱导重试。现在识别为 `MerchantDeclined`，候选投影成 `classification: "rejected"` / `retryable: false` / `detail: merchant_declined:<reason>`，并立刻返回（不再等满超时预算）。
- **买家无法配置签名身份**：`a2aSigningKeyDir` 在 `buildBuyerService` 里存在，但 `mcp serve` 没有任何开关，MCP 买家永远是匿名——商家对 `GetTask` 这类受保护操作要求已验证身份，所以报价永远读不回来。新增 `--a2a-signing-key-dir` / `KIWI_A2A_SIGNING_KEY_DIR`（**保持 opt-in**，默认仍匿名，避免把普通询价变成未验证身份）。

## v0.12.9 — 2026-10-28

- **代码审查修复（商家凭据生命周期）**：`commerce.token_env` 与 Kiwi Catalog owner token 的语义拆分现在集中到 `src/config/credentials.ts`——自动轮换只在两者**不同**时开启（此前判断条件看的是 `credentials.catalog`，导致生产 profile 里把 catalog token 当成 shopping-cli 凭据去轮换），子进程自证也直接拒绝未拆分的 profile；`merchant init` 不再把 `KIWI_MERCHANT_TOKEN` 复制进 `SHOPPING_MERCHANT_TOKEN`。另修：`runtime start` 的跨进程 reconcile 从 1s 改 10s 且不再抢在退避重启前面（否则崩溃循环会退化成每秒重拉、并清零重启计数）、`/token/*` 与 `private-config` 保留 `base_url` 的子路径前缀、`[::1]` 回环可用、响应体改为有界读取、只读命令不再 `chmod` 凭据文件、sidecar 归属按规范化 API 身份比较、切换标记在任何失败路径都会释放（否则 supervisor 永久拒绝拉起子服务）、只重启 mcp 时不再空等 A2A 自证。
- **发布门禁**：`npm audit` 无法运行（网络失败等）时 stdout 里的 `{"error": …}` 不再被当成"零漏洞报告"放行，改为 `SHIPPING_AUDIT_UNREADABLE` fail-closed。

- **修复：自托管 Runtime 无法完成 Catalog 绑定**。Catalog 的设备接入契约要求 `a2a_endpoint == runtime_origin + "/a2a"`，公开预览的 `supportedInterfaces` 必须含这条 URL；而 `kiwi merchant start` 的 A2A 端点缺省在 origin 根（`a2aPath ?? "/"`），`kiwi merchant connect` 因此在本地就以「公网入口返回的 Agent Card 与当前 Runtime 地址不一致」拒绝（`RUNTIME_NOT_READY`），请求到不了 Catalog，商家永远绑不上、商品发布只能走已废弃的 owner token。现在自托管节点的缺省端点改为 `/a2a`（名片同步通告），**根路径 `/` 保留为兼容别名**继续服务旧名片/旧买家；只在主端点为 `/a2a` 时生效。
- **商家凭据生命周期自动化**（随本版发布）：`kiwi merchant credentials rotate|recover` 用 prepare/confirm 协议轮换 shopping-cli 商户 token——先验证新 token 可用、停受管进程、原子更新 `credentials.env`、再等 A2A 子进程用新 token 自证，旧 token 到达成共识前一直有效；`runtime start` 每 5 分钟查一次到期状态，在到期前最多 7 天自动发起轮换。细节见 `docs/merchant-credential-rotation.md`。

## v0.12.8 — 2026-10-28

- **修复：systemd 重启后 A2A/MCP 永久停机**。商家 runtime 的优雅关闭（SIGTERM/`restart`）此前对每个受管子服务调用 `stop()`，而 `stop()` 会落盘 `<name>.stopped` 显式停止意图；新进程 `supervise()` 看到该意图就不再拉起子进程——`Restart=always` 每重启一次，A2A 接待服务和 MCP 管理服务就永久停一次（生产现象：重启商家实例后公网 A2A 502）。现在停止逻辑拆成 `terminate(name,{persistIntent})`：`shutdown()` 只终止进程、不写意图，操作员显式 `runtime stop` 的意图照旧保留并阻止自动拉起。新增两条回归测试（关闭后可被重新拉起 / 显式停止的意图跨关闭保留）。
- **诊断：catalog 作用域凭据缺失的报错不再误导**。此前 profile 已配置 `commerce.credentials.catalog.token_env`、但该环境变量在当前进程里未设置或为空时，报错仍写「未配置」，把「配置缺失」和「部署没把凭据注入进程」混为一谈。现在文本区分为 profile 未配置 / 环境变量未设置或为空两种情况。

## v0.12.7 — 2026-10-28

- **门禁失败可见与公钥登记**：买家遇平台门禁拒绝时，客户端旁路上报 `gate_rejected`（失败不影响报价流程）；工作台在签名读里看到近 24h 计数并提示核对分享码。另外新增 `scripts/trust-buyer-key.mjs`（`src/tools/trusted-buyer-keys.ts`）：把买家的 Ed25519 公钥登记进运行时数据目录的 `a2a-trusted-keys.json`（0600、原子写、重复 keyid 拒绝、必须 Ed25519），受保护操作从此认可该买家身份。工作台的"已撤销"现在区分"被新版本替换"与"撤回"。
- **分享码代管授权（政策风险控制）**：工作台在提交分享链接前必须勾选并同意《分享码代管授权》——「允许 Kiwi 目录代为保管此分享码，并仅在我已接受的采购方关注我时自动出示；可随时撤回，撤回后目录会清空已保存的分享码」。授权条款版本随请求提交（`workbuddy-share-v1-2026-10-27`），过期版本会被目录拒绝；「撤回授权并撤销」同时停止发放并清空密文。工作台还会显示目录代管总开关被运营关闭的状态（此时无法新建/更新，但可撤回）。
- **平台行为回显探针（I-01 服务端）**：新增 `src/tools/workbuddy-echo.ts` 与 `scripts/workbuddy-echo.mjs`——把它发布成 WorkBuddy 网站应用后，可直接量出网关是否剥除/重排查询参数、是否改写或注入 `Authorization`、签名头是否原样透传，不必等平台答复。摘要只含参数名、头名与值摘要：分享码只报"存在 + 长度"，`authorization` 只报方案名与哈希，请求体只报长度与哈希；请求体上限 64 KiB，非 GET/POST/HEAD 返回 405。
- **受保护操作与签名身份（M-05/M-06/B-05）**：`GetExtendedAgentCard` 现在要求已验证身份（匿名返回 `authentication_required`；此前对任何人返回扩展名片），与 `GetTask`/`ListTasks`/`CancelTask` 的匿名拒绝保持一致——`message/send` 的匿名 T0 询价不变。签名模式下 `Authorization` 永不被当作业务身份（平台注入同理）；`KIWI_CLOUD_A2A_AUTH=bearer` 时提交 WorkBuddy 分享配置 fail-closed（`ACCESS_AUTH_MODE_CONFLICT`）。Buyer 侧新增 `a2aSigningKeyDir`：配置后以持久化 Ed25519 身份对每个出站 A2A 请求签名（RFC 9421，覆盖 method/去码 target-uri/content-digest），商家把公钥加入 `a2a-trusted-keys.json` 即可识别该买家；未配置时仍按匿名 T0 处理。
- **WorkBuddy 分享码访问配置（商家侧 M-01～M-04 + Buyer 侧 B-01～B-09 的代码面）**：商家在工作台「WorkBuddy 分享码」卡片粘贴平台分享链接即可登记；解析严格（非 HTTPS、userinfo、fragment、非默认端口、缺失/重复 `sharecode` 一律拒绝），链接 origin 必须与已绑定 `runtime_origin` 逐字一致。提交走 Catalog `PUT /v1/agents/{id}/runtime-access`（当前活动绑定私钥签名，覆盖 method/path/body_digest/agent/binding/epoch + `exp` + 一次性 nonce；409 先做签名 GET 校正版本再只重试一次）。新增签名读 `GET /v1/agents/{id}/runtime-access`（本地状态丢失后恢复 head 版本、工作台显示 pending/invalid/revoked）。首绑可用 `KIWI_CLOUD_ACCESS_SHARE_LINK` 随绑定提交。Buyer 侧：`MerchantAccessSource` 经目录会话受控取码（60s 缓存 + 单飞 + 严格校验 origin/adapter/auth_mode），`buildWorkbuddyDualAddress` 构造"签名地址 / 发送地址"（业务参数按原字节保留），`A2AClient` 新增 `sendUrl`（签名仍覆盖原地址）并把分享参数带到 card 读取与每一次 RPC（含协议恢复）；WorkBuddy 商家不发送标准 `Authorization`。失败语义：平台门禁拒绝归类 `access_denied`、配置缺失 `access_unavailable`，不再与"商家拒绝报价"混谈；错误文本统一抹掉 `sharecode`。分享码只进请求体与内存，运行时不落盘、不回显、不进日志。
- **buyer HTTP 面（review P1-1）**：`kiwi buyer-api serve` 新增 `--auth-token`（或 `KIWI_BUYER_HTTP_TOKEN`）Bearer 认证；令牌为必选，未配置时拒绝启动（fail-closed）；除 `/health` 外全部端点要求令牌，loopback 来源也不豁免认证。新增 Host 头 allowlist（防 DNS rebinding）、请求体超限 413（此前继续累积可内存 DoS）、坏 JSON 400（此前被吞成空对象）。404 不再回显请求 path。
- **buyer 授权层（review P1-2）**：DelegationPolicy.limits（max_total_price/max_unit_price/max_quantity/allowed_merchants/allowed_currencies）此前在 accept 路径完全不执行，现在对候选真实核验（价格文本解析，解析不出 fail-closed 拒绝）；ASK 审批绑定 task_id 与 candidate digest；审批一次性消费（accept/handoff 落地后即 used）。
- **enrollment store 并发（review P1-3）**：`catalog-pipeline` 的 `saveWorkbuddyEnrollment` 并入 `withEnrollmentStoreLock` + store_revision CAS——此前 30s reconcile tick 的裸回写可覆盖持锁写入方（回滚 challenge consumed 记录制造重放窗口）。
- **claim 泄漏（review P1-4）**：autopilot submit 异常路径与 controller record 失败路径现在释放 claim/心跳，不再滞留到网关 300s stale TTL。
- 协议组：merchant handler 的 withdraw/decline scope=offer 补相位推进（§21.2）；accept_nonbinding 接受全部自产 offer-like 对象（互操作）；商家 conditional_offer 先过冻结校验器（含扩展字段透传，3-9）；幂等 in-flight 改 `wx` 原子 claim（2-9）、损坏记录 fail-closed（3-4）、sweep 清理 inflight 残留（3-3）、确定性 decline 清除标记（3-10）；digest 剔除表移除（2-5）；TermSet/LineItem 透传 schema 允许的扩展字段。
- 依赖：`npm audit fix`（proxy-addr critical、MCP SDK high → 1.32.1）。
- 其他：AiRuntimeGate 租约表有界（2-11）；带 expires 的签名窗口 15 分钟上限（2-14）；预算阈值不再出现在跟踪通知（2-21）；shortlist_listing 补 manual 守卫（2-22）；快照 abandon 不再吞成功结果（2-23）；merchant up 节点失败不再孤儿化 Caddy（2-26）；README 版本号同步。
- **平台商品页链接（商家交易入口）**：商品表新增可选**成对**字段 `trade_platform`/`platform_product_id`（仅京东/淘宝/天猫），由 Kiwi 按平台固定路由生成商品页 URL（`item.jd.com`、`item.taobao.com`、`detail.tmall.com`）——商家不提交任意 URL，ID 一律按 ASCII 正整数字符串处理（不转数字，超长 ID 不丢精度），平台与 ID 缺一即拒绝（CSV/XLSX 报该行错误、整批不生效；JSON 商品表直接判表无效）。CSV/XLSX/JSON 三条导入路径与工作台模板同步支持；模板 L 列带平台下拉、M 列强制文本格式，数字/公式单元格按类型错误拒绝（提示重新复制准确 ID）。商家管理页新增「交易平台/平台商品ID/平台商品页链接」三列（仅 https 且三平台域名可渲染，其余显示「-」），并标明「交易链接仅为平台商品页；是否成交、实际价格与付款结果由交易平台确认」。发布到 Kiwi 目录时 listing 携带 `handoff_destination_types: ["external_checkout_url"]` 与 `handoff_destination_ref`（每商品成交入口）；买家侧商品投影透出同一字段。商家协议链路：文件商品源把该 URL 作为 `handoff_destination` 交给 merchant handler，KTH 候选携带 `destination_type`/`destination_ref` 且 `requires_user_action`，仍需买家批准后才落地——不新增下单、付款、锁库存或 URL 预检语义，既有商品表（无此二列）行为不变。
- **BREAKING（协议 digest 算法对齐 RFC 8785，审查 2-4）**：JCS 数值序列化此前把 `-0` 输出为 `"-0"`、并剥掉正指数的 `+`（`1e21` → `"1e21"`），与 RFC 8785 §3.2.2.2（以 ECMAScript `Number::toString` 为权威：`-0` → `"0"`、`1e21` → `"1e+21"`）不符。修复后凡涉及 `-0` 或 ≥1e21 数值的 content digest / envelope digest / terms_digest / policy_digest 与旧实现**不兼容**；当前业务值均为整数 minor units（<1e21），仅当历史持久化数据曾含此类数值时才需按对账流程重建旧 envelope/ledger digest。同批（审查 2-5）：digest 计算移除本地 transport-signature 字段剔除表（KNP §19.2 第 7 条「MUST NOT invent a local signature-field stripping list」）；合法 envelope 从不携带这些字段，既有 digest 不变，携带方不再被静默豁免而是 fail-closed。

## v0.12.3 — 2026-10-01

- 会话旁观（只读）投影修正：SKU 与数量现在从真实 KNP 扁平账本载荷回填（rfq 明细行 `items`、offer `terms`、counter_offer `proposed_terms`、conditional_offer `base_terms`；WP11 初版误读的嵌套形状会被入站校验拒绝、从不出现在真实账本，导致旁观 SKU/数量恒为空）。询价/澄清问题原文与运营报告「最近询价关键词」按同一扁平口径修复（clarification 问题取 `field`）。历史账本无需迁移，扫描时即正确投影。
- 隐私边界不变：单价/金额按既有设计不进旁观视图（规则数值属私有数据，A41 核验确认），底价/折扣等策略字段仍不外露；API/页面形状不变（`price_minor`/`unit_price_minor` 字段保留、恒缺省）。不改变鉴权、账本写入与磋商协议语义。

## v0.12.2 — 2026-09-30

- 配对诊断：绑定步骤失败与签名声明验真失败现在以稳定安全码（BIND_REJECTED / BIND_CLAIM_INVALID / BIND_CLAIM_CARD_URL_MISMATCH / BIND_CLAIM_FIELD_MISMATCH / CARD_PUBLISH_* / PAIRING_COMMUNICATION_FAILED / PAIRING_WINDOW_EXPIRED）出现在目录连接摘要与工作台连接卡；授权过期显示粘性可重试提示，不再无提示回到未连接。
- 不改变认证、安全门、重试语义与既有协议；不反射任何远端错误原文或凭据。


## v0.12.0 — 2026-09-29

- Add read-only `kiwi_catalog_get_service_status` to the WorkBuddy merchant gateway connector tool contract.
- Add `@harrylabsj/kiwi-merchant-cloud` to the signed portfolio release artifact and protected npm publisher job.
- Prepare a post-publication registry-integrity backfill for the `kiwi-cloud-deploy` release pin.

## v0.10.0 — 2026-09-18

**商家连接器：网关职责收敛为第 0 版目录能力**：
- 确立**「网关不碰实例」原则**（部署说明 §0）：网关不持有商家实例的地址或凭据、不代理实例工具、不参与买家与商家的 A2A 磋商。商家实例完全独立、直接与买家做 A2A。原「网关安全路由到已配对实例」的第 1 版方案**暂缓**，代码保留作兜底（启用条件已写入文档）。
- 商家侧 Buddy 收窄为只做「目录注册与发布」；`kiwi_merchant_*` 实例工具**本就不该出现**，不必为此排障。
- 网关安全缺口收口（入口与实例注册/路由、出站钉住，含对应测试）。

**商家侧新增目录数据能力**：
- `kiwi_catalog_get_merchant_stats`：**经营汇总**——活跃关注者总数 + 公开资料总浏览量 + 每条资料的状态与浏览量。同一目录端点本就返回这些字段，此前只透出关注数。
- `kiwi_catalog_get_publication`：读单条资料时**带回可编辑内容**（商家名/商品名/类目/简介/店铺平台与链接/FAQ），使「文案优化」不必凭记忆重写。
- Buddy 应用配置 1.4.0：systemPrompt 增加文案优化指引与硬规则（不得编造规格/认证/产地、不得写联系方式；改完存草稿、仍须门户确认），并补对应胶囊。
- 隐私边界不变：目录只提供**匿名聚合**，不返回关注者身份、名单或联系方式，也没有群发通道。

**部署与文档**：
- 目录升级改为**只用 PyPI 公开发布物**（新增部署说明 §6.1），并记录两条实测坑：本机 pip 默认走阿里云镜像需显式 `--index-url https://pypi.org/simple/`；服务对 DB 是懒加载，**重启不会跑迁移**，需显式触发。
- 修 systemd 模板缺失的 `User=`/`Group=`（照原样安装会让网关以 root 运行）。
- 新增[现网拓扑实测与迁移记录](docs/merchant-buddy/production-topology-gap-and-migration.md)：两套 A2A 并行、目标拓扑差异、四步迁移与执行结果（含查出的两个线上故障：实例无 WP6 心跳、身份域名与 card URL 不同源）。

## v0.9.0 — 2026-09-18

**WorkBuddy 商家连接器（新）**：
- 商家连接器「Kiwi 商家运营」的远程 MCP 入口（OAuth 2.1 + PKCE）：无会话 authorize → `/connect` → 目录注册/登录确认 → 一次性 code → 兑换 `merchant_id` 与商家目录凭据 → 入口会话 → 授权同意 → 授权码。买方连接器 `kiwi-sourcing` 的传输与鉴权**保持不变**（两个连接器 source、平台 ID、凭据互不通用）。
- 五个 `kiwi_catalog_*` 目录工具（身份/草稿/请求发布/状态/撤回）：发布只产草稿并给出**门户确认入口**，模型不能自批发布。
- 实例自助绑定与路由：粘贴内部令牌或一次性配对码（10 分钟 TTL、单次、只存 sha256）。按最小授权原则**凭据由实例签发与持有，网关不参与签发**；配对凭据单槽轮换、可吊销。未绑定实例不阻塞第 0 版目录能力。
- 出站加固：静态 URL 策略 + DNS 钉住（解析→校验全部 IP→按 IP 连接，Host/SNI 保持域名）、`redirect: manual`、能力探测 fail-closed。

**Kiwi Merchant Buddy V2（商家侧）**：
- 商家 OAuth 2.1 授权服务器（PKCE / RFC 7591 动态注册 / refresh 轮换 / revoke）、scope 过滤、`merchant-runtime` 与 `deploy/merchant-bundle`。
- `src/merchant-core/` 与 17 个 `kiwi_merchant_*` 工具、七类 presentation 映射；WorkBuddy 商家工作台远程 MCP 接入（四阶段）。
- 三轮 review 修复：协议协商取代版本上限，审批/幂等/底价/运行时加固；写操作一律走审批候选，私密字段（底价/成本）零泄露。

**买家侧**：
- `feat(buyer)`：拉取式订阅工具——关注/更新/列表/取消 + 专家表达。
- `feat(buyer)`：`kiwi_search` 合并 M0 商家公开资料 + RFQ 硬门 + 专家/Buddy 第 0 版表达。
- `feat(buyer)`：Agent 新鲜度（WP6）——心搏 + 读时按 TTL 派生**有效**新鲜度（只降不升），商家服务离线后不再被标「可实时询价」，公开资料仍可查；新增 `merchant_offline` 错误码。
- `fix(a2a)`：报价交期改为动态计算，不再对买家报过期固定日期。

**宿主接入与安全**：
- `feat(integrations)`：WorkBuddy 采购询价专家包 `kiwi-procurement-expert`。
- `chore(deps)`：vitest 4.1.11（修复 GHSA-82fw-gwwq-j7x9）。
- 安全收口：配对码取模偏差改为拒绝采样；`/mcp` 与 buyer HTTP 侧不再向调用方回显内部异常消息（只进 stderr）；7 处二次方回溯正则改为线性扫描（新增 `src/net/url.ts`，与旧写法逐例等价）；`/connect/callback` 的 `resume` 增加同源二次校验。

**文档**：商家连接器发布计划、部署说明（同机网关 + 商家实例的 Host/路径分流）、实例配对安全设计、上架素材包；第 1 版产品流程与 onboarding 设计、Kiwi Merchant Buddy V2 开发计划。

## v0.8.0 — 2026-09-03

**Merchant Experience + 公共宿主接入**：
- 商家 Agent 新增 intelligence、grounding、presentation、fencing 和 Host Event 能力，并提供独立 HTTP/SSE 接入层。
- 商家 skill 支持版本化加载、按需读取和生产包校验，保持权限、审批和 Handoff 边界不变。
- Hermes Buyer skill 改为公共路径，并优先从 npm 包内置资源安装；协议和架构文档统一指向当前权威版本。

**依赖与 CI 治理**：
- `chore(deps)`：eslint 10.8.1 / @eslint/js 10.0.1 / typescript-eslint 8.67 / typescript 6.0.3（渐进，TS7 待工具链适配）/ @types/node 26 / fast-uri 3.1.7（安全修复）。
- `ci(codeql)`：init/autobuild/analyze 统一到 v4.37.7。

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
