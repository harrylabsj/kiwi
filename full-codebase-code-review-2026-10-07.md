# 全库代码审查：114项当前裁定与验收状态

更新日期：2026-10-09。当前提交：Kiwi `3f2aa60`、kiwi-catalog `2f1ea11`（包含已收尾33项）。本批22项建议落实的40路径已采用到工作区，未暂存/提交/推送/部署。

## 当前结论

81项原问题限定收尾，22项建议已按批准范围交付；3项仍待证据，8项非bug。当前确认待修bug为0，不表示全库无bug或生产上线通过。

| 当前状态 | 数量 | 含义 |
|---|---:|---|
| 原问题已收尾（限定接受） | 81 | 原48与后33均已本地提交，风险与适用范围继续保留 |
| 建议已落实（限定交付） | 22 | 9小加固、7策略、4测量、2专项；代码/文档已采用，密钥拆分仅方案和离线证明 |
| 证据不足待核 | 3 | 先补真实可达链/合同，不假定漏洞成立 |
| 不成立/不按bug | 8 | 保留原裁定，不为统计改动 |
| 合计 | 114 | 不将22建议冒成22已证漏洞修复 |

[22项建议落实验收报告](/Users/jianghaidong/Documents/Codex/2026-09-29/new-chat-2/outputs/Kiwi-22项建议落实验收报告-20261009.md) · [33项逐项报告](/Users/jianghaidong/Documents/Codex/2026-09-29/new-chat-2/outputs/Kiwi-33项修复最终验收报告-20261009.md)。

最后联合INPUT `9c008e51df648d6a26783a0528feed3c5fecd8cd24e2270aaec74d3f5f112e27`，1439源，40差分（Kiwi33/Catalog7）。分组非作者验收、最终联合与必要构建完成，经理只读核证及主库逐路径读回。原3-40兼容真红已另冻R1修后复验，失败证据保留。

未来容量分段/lease checkpoint、生产分用途密钥轮换/DB迁移不在本轮实施；测量值非生产SLO，文档/离线证明不冒真实业务测试。Buddy与旧定时仍暂停，不提交/推送。

## 本批33项验收闭环

[33项逐项验收报告与证据矩阵](/Users/jianghaidong/Documents/Codex/2026-09-29/new-chat-2/outputs/Kiwi-33项修复最终验收报告-20261009.md) · [受控采用报告](/private/tmp/kiwi-a385-original33-adoption/REPORT.md)。

固定输入A381-R1 SHA256 `d4a67596a9da22f63ddd7ec7950000ebaa6d2c7286ab1a914ebc927c8be1e1ff`，1416源文件；采用95差分路径（Kiwi87/Catalog8）。分组独验通过后，又完成默认factory/限额/只读恢复、同DB事务/unknown幂等与Catalog签名/队列/deadline接缝验证。经理只读核证，没有另跑技术测试或将跳过case计为通过。

最后两HOLD：2-7稳定协议恢复、3-13生产默认Nodepin装配，已由A377-R1复验及A383-R1联合验证关闭。A383-R1 5新增控制、type/build通过；A384 5联合控制（含3既有代表）及3卡片选控通过。原红证据和测试夹具修正记录保留，不简单累加各轮计数为覆盖率。

局限：自有loopback/TLS合成CA/临时SQLite与合成业务，不代表生产认证部署、真实交易、断电或跨机exactly-once；unknown保守阻断不按TTL重驱。原48限定风险继续有效；未迁移真实DB、安装依赖或启动平台。Buddy与定时任务仍暂停。

## 22项建议落实结果

| ID | 原分类 | 完成交付与边界 | 非作者证据 |
|---|---|---|---|
| 2-17 | 明确策略 | CSRF为主门、云Origin显式配置和无Origin客户端合同明确；与定价预览共享既有保护，不把Origin当认证。 | [A391](/private/tmp/kiwi-a391-protocol-hardening-independent/REPORT.md) |
| 2-18 | 明确策略 | 人工对账runbook交付，绑定原enrollment/operation、身份权限与权威效果回执；unknown保留，无清锁或重驱命令。 | [A391](/private/tmp/kiwi-a391-protocol-hardening-independent/REPORT.md) |
| 2-25 | 先测量 | 真实operations JSON 1k/10k/50k测量及容量方案完成；50k约23.1MB、读中位92.27ms、写73.09ms，阈值只是设计建议，无GC/迁库。 | [A389](/private/tmp/kiwi-a389-catalog-hardening-independent/REPORT.md) |
| 3-1 | 明确策略 | state与revision区分；无revision证据返回staleness unknown/stale空，不调用expireStale，确认及成功重放不销毁批准。 | [A391](/private/tmp/kiwi-a391-protocol-hardening-independent/REPORT.md) |
| 3-6 | 先测量 | 真实FileLeaseStore 100/1k/10k token测量；10k约3万文件p95约40.47ms，每次1scan/2read；fencing单调，未压缩。 | [A391](/private/tmp/kiwi-a391-protocol-hardening-independent/REPORT.md) |
| 3-12 | 明确策略 | 每poll局部tracker合同与跨轮业务责任明确，无新无界缓存；预算与正常转换保持。 | [A391](/private/tmp/kiwi-a391-protocol-hardening-independent/REPORT.md) |
| 3-25 | 小幅加固 | 共同typed规则校验；非法直调不写规则/事件且不消耗工具幂等键，schema与DB CHECK保留。 | [A390](/private/tmp/kiwi-a390-app-hardening-independent/REPORT.md) |
| 3-26 | 先测量 | 真实SQLite检索规模/排序/隔离核验完成；10k约35–39ms，保持原实现，记录>=10k或实际p95>=50ms复测建议。 | [A390](/private/tmp/kiwi-a390-app-hardening-independent/REPORT.md) |
| 3-27 | 小幅加固 | 上游完整方法形状检查，不兼容明确failclosed；真实session文件0600与thinking不落盘/reopen保持。 | [A390](/private/tmp/kiwi-a390-app-hardening-independent/REPORT.md) |
| 3-28 | 先测量 | 实测二次扫描后改每getter/neg局部Map；独立3600event中位195.151→1.643ms，保key/order/first/last/多neg及二次读取等价，无跨轮缓存。 | [A390](/private/tmp/kiwi-a390-app-hardening-independent/REPORT.md) |
| 3-29 | 小幅加固 | 非法注入时钟明确配置错误；开资源前校验及初始化中失败关闭DB/清timer，完整运行后的close责任仍在caller。 | [A390](/private/tmp/kiwi-a390-app-hardening-independent/REPORT.md) |
| 3-30 | 专项评估 | 临时WAL评估发现metadata缺口后补已存在WAL/SHM regular/no-symlink/同UID/0600检查；缺失和正常checkpoint/recreate可用，不删/chmod/绑定inode。 | [A389](/private/tmp/kiwi-a389-catalog-hardening-independent/REPORT.md) |
| 3-35 | 小幅加固 | 内存与SQLite预算adapter共同未知/重复lease、金额绑定、结算和释放契约一致；生产SQLite不改，内存仍不持久。 | [A390](/private/tmp/kiwi-a390-app-hardening-independent/REPORT.md) |
| 3-37 | 小幅加固 | pricing preview POST复用CSRF/Origin门，保session/products:read，合法无Origin可用；不是订单支付漏洞修复。 | [A391](/private/tmp/kiwi-a391-protocol-hardening-independent/REPORT.md) |
| 3-38 | 明确策略 | 管理Origin、WebAuthn exactHTTPS/RP及enrollment签名URL各合同明确，各自正负控制通过，不统一放宽。 | [A391](/private/tmp/kiwi-a391-protocol-hardening-independent/REPORT.md) |
| 3-39 | 明确策略 | 仅WebAuthn注册/确认配置提前提示HTTP不支持，保严格HTTPS和普通HTTP session/read/OAuth；无真实浏览器注册声明。 | [A391](/private/tmp/kiwi-a391-protocol-hardening-independent/REPORT.md) |
| 3-40 | 小幅加固 | start监听前认证策略及裸MCP可信socket纵深；isIP后复用全127/8与mapped loopback，unknown/伪头/非loopback拒；IPv6返回URL可直接用。 | [A391](/private/tmp/kiwi-a391-protocol-hardening-independent/REPORT.md) |
| 3-52 | 小幅加固 | 删除signedEnrollment早退后的不可达owner分支，签名发布正负仍相同，不恢复unsigned fallback。 | [A390](/private/tmp/kiwi-a390-app-hardening-independent/REPORT.md) |
| 3-53 | 小幅加固 | cursor或seen变化才保存、成功后确认；实际文件空轮/stop无重复写，重启去重保持，未调用真实微信。 | [A390](/private/tmp/kiwi-a390-app-hardening-independent/REPORT.md) |
| 3-60 | 明确策略 | legacy HMAC仍body-only、body非空优先、随机active Bearer与legacy-off合同明确；revoked/rotated不降级，auth语义AST不变。 | [A389](/private/tmp/kiwi-a389-catalog-hardening-independent/REPORT.md) |
| 3-62 | 小幅加固 | 新issue/rotate审计使用domain-separated sha256:v1完整指纹；无raw/24前缀，历史审计原bytes和合法token返回接口保留。 | [A389](/private/tmp/kiwi-a389-catalog-hardening-independent/REPORT.md) |
| 3-63 | 专项评估 | 分用途版本化密钥方案及离线兼容证明完成；v1/v2、新旧reader/writer、pending grant与回退边界覆盖；生产key/env/schema及v3读取未实施。 | [A389](/private/tmp/kiwi-a389-catalog-hardening-independent/REPORT.md) |


<details>
<summary>22项原建议、原范围与验收要求（历史）</summary>

## 待设计决策或加固（22项）

| ID | 原裁定 | 当前收窄描述 | 最低验收标准 / 下一步 | 当前源码定位 |
|---|---|---|---|---|
| 2-17 | 部分成立/需收窄 | Origin额外检查仅在头和allowedOrigins都存在时执行，但写路径先核session绑定CSRF；cloud实际传publicOrigin。不能把无Origin或省allowlist直接叫管理写认证绕过。 | 文档明确CSRF主门与可选Origin纵深策略；若要求缺省allowlist，需装配正负控并保合法无Origin非浏览器调用，不移除CSRF。 | [kiwi/src/http/merchant-management/api.ts:3491](/Users/jianghaidong/coding/kiwi/src/http/merchant-management/api.ts:3491)<br>[kiwi/src/cloud/bootstrap.ts:872](/Users/jianghaidong/coding/kiwi/src/cloud/bootstrap.ts:872) |
| 2-18 | 部分成立/需收窄 | Connect未知/崩溃锁与effectStarted后不确定claim保留阻断；当前缺面向运维的权威对账与恢复流程。 这是刻意fail-closed安全选择，不是一次任意网络抖动都永久砖死；已知未开始效果/read-only失败可自动释放。不能建议按PID/TTL删unknown锁/claim。 | 先明确权威结果与operator恢复授权合同；恢复需绑定原enrollment/operation及效果证明，未知仍阻断。；只需文档描述可安全释放与必须对账场景；本轮不新增自动清锁、重驱命令或经营权限。 | [kiwi/src/cloud/binding/store-lock.ts:1](/Users/jianghaidong/coding/kiwi/src/cloud/binding/store-lock.ts:1)<br>[kiwi/src/cloud/binding/store-lock.ts:65](/Users/jianghaidong/coding/kiwi/src/cloud/binding/store-lock.ts:65) |
| 2-25 | 成立 | operations.json保留操作及幂等/对账状态，读写全量JSON且记录持续增长是容量债务；本轮未测得磁盘/延迟故障，不把缺GC称当前安全漏洞。 | 定义容量/归档政策并有合成长历史性能证据；任何优化不得删pending/reserved/reconciliation/unknown或失去幂等tombstone。 | [kiwi/src/merchant/ai-runtime/owner-session.ts:611](/Users/jianghaidong/coding/kiwi/src/merchant/ai-runtime/owner-session.ts:611)<br>[kiwi/src/merchant/ai-runtime/owner-session.ts:1197](/Users/jianghaidong/coding/kiwi/src/merchant/ai-runtime/owner-session.ts:1197) |
| 3-1 | 部分成立/需收窄 | 恢复模块revisionChanged实际比task state字符串，并把所有localSent含本轮已replayed列为stale；返回/未来expireStale语义与“revision变化”名义不一致。 src没有生产NegotiationRecovery实例化或expireStale注入，不能称生产批准必被销毁；需先明确远端revision能力及stale合同。 | 明确state与revision语义；已确认送达/本轮重放成功消息不误列stale。；无revision能力时诚实限定/要求对账；若提供expire hook，验证仅未确认旧候选受影响，不擅加经营写。 | [kiwi/src/negotiation/recovery/recover.ts:584](/Users/jianghaidong/coding/kiwi/src/negotiation/recovery/recover.ts:584)<br>[kiwi/src/negotiation/recovery/types.ts:94](/Users/jianghaidong/coding/kiwi/src/negotiation/recovery/types.ts:94) |
| 3-6 | 成立 | FileLeaseStore journal长期保留claim/renew/release；snapshot全目录readdir找最大token，并读当前claim和该token的renew记录，扫描成本随历史增长。 旧“逐一读所有历史文件”不准确；append-only记录维持fencing单调，不能简单TTL删claim或重用token。未做实际规模性能测量。 | 若决定压缩，必须保最大fencing token与活/未知owner，不回退token；并发旧owner不能夺回。；限定/度量历史扫描和当前renew读成本，再决定checkpoint/保留策略；正常lease/renew/release语义保持。 | [kiwi/src/negotiation/lease/store.ts:54](/Users/jianghaidong/coding/kiwi/src/negotiation/lease/store.ts:54)<br>[kiwi/src/negotiation/lease/store.ts:142](/Users/jianghaidong/coding/kiwi/src/negotiation/lease/store.ts:142) |
| 3-12 | 部分成立/需收窄 | 同TaskPoller对象每次poll都新建生命周期tracker；跨poll无历史观察，非法回退只在单次poll内校验。 多数调用一次就到terminal/input-required；若每poll刻意代表独立观察回合不应直接算生产状态回退bug。先明确复用会话合同。 | 声明tracker是每回合还是每task生命周期；若承诺跨poll，外部复用历史并拒同task terminal→working回退。；合法单次poll转换、不同task独立跟踪与既有deadline/attempt预算不变。 | [kiwi/src/a2a/task/poller.ts:189](/Users/jianghaidong/coding/kiwi/src/a2a/task/poller.ts:189)<br>[kiwi/src/a2a/task/poller.ts:245](/Users/jianghaidong/coding/kiwi/src/a2a/task/poller.ts:245) |
| 3-25 | 部分成立/需收窄 | 工具schema enum已有约束，DB rule_type CHECK也拒非法值；原“非法规则静默入库且永不触发”在正常schema下不成立。剩余是execute cast及store直调缺统一业务validation错误的纵深/UX问题。 | 若收口，非法直调返回typed validation且零行，合法类型保持；不能以此宣称schema有效输入可绕数据库。 | [kiwi/src/agent/buyer/buyer-tools.ts:1069](/Users/jianghaidong/coding/kiwi/src/agent/buyer/buyer-tools.ts:1069)<br>[kiwi/src/agent/memory/schema.ts:211](/Users/jianghaidong/coding/kiwi/src/agent/memory/schema.ts:211) |
| 3-26 | 成立 | memory检索按principal/status取全量后JS过滤评分，limit只裁输出；有线性成本事实但无本轮规模/延迟故障证据，属于性能改进候选。 | 先合成规模基准和保排序结果；SQL预过滤不得任意LIMIT丢候选或改变scope权限。 | [kiwi/src/agent/memory/store.ts:955](/Users/jianghaidong/coding/kiwi/src/agent/memory/store.ts:955) |
| 3-27 | 部分成立/需收窄 | session wrapper依赖appendMessage/_persist/_rewriteFile现有形状；方法缺失的.bind会直接失败，不支持“升级必静默失去0600/no-thinking”断言。kernel streamSimple wrapper只控制cacheRetention，不是thinking防线。 | 维护上游形状/文件0600与思考内容不落盘的兼容性控；不兼容显式failclosed，不能只凭cast判当前不变量失效。 | [kiwi/src/agent/session.ts:73](/Users/jianghaidong/coding/kiwi/src/agent/session.ts:73)<br>[kiwi/src/agent/kernel.ts:347](/Users/jianghaidong/coding/kiwi/src/agent/kernel.ts:347) |
| 3-28 | 部分成立/需收窄 | handoffRuntime非空断言有前置guard；每候选多次events.filter确有重复扫描，不是已证空指针安全故障。 | 若优化，正常/未装handoff路径保持，并以合成大事件集证明扫描改善而结果不变；不作为待安全bug。 | [kiwi/src/agent/kernel.ts:870](/Users/jianghaidong/coding/kiwi/src/agent/kernel.ts:870)<br>[kiwi/src/agent/kernel.ts:880](/Users/jianghaidong/coding/kiwi/src/agent/kernel.ts:880) |
| 3-29 | 部分成立/需收窄 | clock normalization对不可解析的可信options.now值调用toISOString会抛RangeError；默认Date时钟合法。不能仅凭lambda声明断言每次open必崩，触发取决于clock何时被调用。 | 坏clock注入给明确配置/测试错误并收尾已开资源；正常UTC归一与可用时钟保持，不升为生产P1。 | [kiwi/src/agent/kernel.ts:570](/Users/jianghaidong/coding/kiwi/src/agent/kernel.ts:570)<br>[kiwi/src/agent/kernel.ts:597](/Users/jianghaidong/coding/kiwi/src/agent/kernel.ts:597) |
| 3-30 | 部分成立/需收窄 | admission显式校验主库owner/mode/非symlink和上级0700；没有单独sidecar检查是纵深缺口，本轮无WAL/SHM公开泄露证据。 | 仅临时WAL库核sidecar模式/owner/替换情形，再定是否需要加固；不能清活跃sidecar或以此要求真实密钥/数据库迁移。 | [kiwi/src/merchant/ai-runtime/owner-storage-admission.ts:84](/Users/jianghaidong/coding/kiwi/src/merchant/ai-runtime/owner-storage-admission.ts:84)<br>[kiwi/src/merchant/ai-runtime/owner-storage-admission.ts:101](/Users/jianghaidong/coding/kiwi/src/merchant/ai-runtime/owner-storage-admission.ts:101) |
| 3-35 | 部分成立/需收窄 | test-only内存budget adapter对未知lease用传入reservedAmount结算，SQLite adapter拒unknown_lease；这是替身契约漂移，不是生产SQLite预算绕过。 | adapter conformance对同/未知/重复lease结果一致，保预算记账幂等；不改变生产恢复政策。 | [kiwi/src/merchant/ai-runtime/gate.ts:109](/Users/jianghaidong/coding/kiwi/src/merchant/ai-runtime/gate.ts:109)<br>[kiwi/src/merchant/ai-runtime/sqlite-budget-store.ts:254](/Users/jianghaidong/coding/kiwi/src/merchant/ai-runtime/sqlite-budget-store.ts:254) |
| 3-37 | 成立 | pricing/previews POST先要求管理session与products:read，但不调用CSRF/Origin写guard，仅触发计算。浏览器是否能携cookie跨站触发受cookie/site条件限制，本轮无浏览器攻击证据；不能称订单/支付CSRF。 | 明确只读POST策略并按有限计算资源选择CSRF防护；若认攻击，先证明具体cookie/同站条件与计算到达，正常已授权预览仍可用。 | [kiwi/src/http/merchant-management/api.ts:1100](/Users/jianghaidong/coding/kiwi/src/http/merchant-management/api.ts:1100)<br>[kiwi/src/http/merchant-management/api.ts:3455](/Users/jianghaidong/coding/kiwi/src/http/merchant-management/api.ts:3455) |
| 3-38 | 部分成立/需收窄 | 管理CSRF附加Origin、WebAuthn精确HTTPS/RP、enrollment签名绑定runtime_origin服务不同信任目的；实现不同本身不是bug，不能统一成同一宽松政策。 | 列清每个origin合同并做各自正负控；若抽公共解析仅共享语法，保各自策略和绑定检查。 | [kiwi/src/http/merchant-management/api.ts:3491](/Users/jianghaidong/coding/kiwi/src/http/merchant-management/api.ts:3491)<br>[kiwi/src/http/merchant-management/webauthn-confirmation.ts:862](/Users/jianghaidong/coding/kiwi/src/http/merchant-management/webauthn-confirmation.ts:862) |
| 3-39 | 成立 | cloud配置/OAuth允许loopback HTTP自检，但WebAuthn确认严格HTTPS，形成部署能力差异；未证本地HTTP承诺支持全部可信确认。是需明确的功能/安全策略选择，非认证绕过。 | 决定本地HTTP确认明确不支持并提前提示，或明确批准有限loopback/RP绑定支持；不得无差别放宽所有HTTP origin。 | [kiwi/src/cloud/config.ts:133](/Users/jianghaidong/coding/kiwi/src/cloud/config.ts:133)<br>[kiwi/src/http/merchant-management/webauthn-confirmation.ts:862](/Users/jianghaidong/coding/kiwi/src/http/merchant-management/webauthn-confirmation.ts:862) |
| 3-40 | 部分成立/需收窄 | 裸MCP handler auth可选；生产merchant-runtime-assembly实际调用assertMerchantMcpAuthPolicy拒无认证nonloopback。缺裸构造器防御不能作已证公网无auth装配。 | 若加固裸API，给非loopback无verifier failclosed的专用构造控；保明确本机部署契约，不新增OAuth架构。 | [kiwi/src/mcp/merchant-server.ts:939](/Users/jianghaidong/coding/kiwi/src/mcp/merchant-server.ts:939)<br>[kiwi/src/mcp/merchant-runtime-assembly.ts:221](/Users/jianghaidong/coding/kiwi/src/mcp/merchant-runtime-assembly.ts:221) |
| 3-52 | 成立 | signedEnrollment===null已早退，后面else owner-token lookup/register分支不可达；维护性死代码成立，非新增匿名发布漏洞。 | 若清理只删不可达owner分支并保signed enrollment守卫与稳定结果，不重新开启unsignedfallback。 | [kiwi/src/product-publish.ts:282](/Users/jianghaidong/coding/kiwi/src/product-publish.ts:282)<br>[kiwi/src/product-publish.ts:302](/Users/jianghaidong/coding/kiwi/src/product-publish.ts:302) |
| 3-53 | 成立 | 每个成功long-poll周期无条件保存sync state，空轮询也写；写放大是实现事实，未证实时故障。不能只按cursor优化而丢seen变化。 | 仅在cursor或seen任一变化时持久化，稳定空轮询不写；重启去重/游标合同不退化，合成fixture不调用真实微信。 | [kiwi/src/weixin/channel.ts:237](/Users/jianghaidong/coding/kiwi/src/weixin/channel.ts:237) |
| 3-60 | 部分成立/需收窄 | require_merchant_token先从body owner_token或transport _auth_token选择presented，用于merchant_tokens active随机token；无token行且legacy启用时最终仍调用只读body的require_owner_token。仅Bearer携带legacy HMAC不能通过该fallback；该body-only约定已写在require_owner_token文档，不能把它当已承诺的header支持普遍坏掉。 仅无merchant_tokens行/本地conn=None的HMAC legacy fallback；随机active token的Bearer路径不受此问题影响。 management-descriptor/merchants self读面走随机token解析，不是该legacy fallback，不得将P1-6既有结论重列为新bug。 实际写caller有agent_catalog鉴权和listings owner helper；Header由transport注入_auth_token，body不会因此自动获得legacy兼容。 | 先作明确合同选择：legacy保持body-only并使双路径说明/调用指导一致，或明确支持legacy Bearer再统一凭据抽取；不凭“待确认”贸然开放新入口。；若支持legacy header，合成覆盖legacy仅body、仅header、两者冲突时的明确优先级；随机active token header仍可用、revoked/rotated行不能降级HMAC复活。；保conn带DB的legacy-off拒绝以及本地CLI独立信任边界，不因兼容变更接受URL query凭据。 | [kiwi-catalog/kiwi_catalog/api/auth.py:191](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/api/auth.py:191)<br>[kiwi-catalog/kiwi_catalog/api/auth.py:225](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/api/auth.py:225) |
| 3-62 | 部分成立/需收窄 | issue/rotate将token[:24]写入audit_events.details_json。当前token为mkt_加32随机字节urlsafe，24字符含4字面前缀和20个随机base64字符（约120随机bit），并非全token，理论剩余约136bit；不能沿用“前缀就是可用凭据”说法。 只讨论catalog商户随机owner token的签发/轮换审计细节，不是平台merchant_id随机后缀。 源码中审计展示hint明确，但本轮没有证明未授权人能读取该审计面；账号合法返回自己完整token也不是该审计披露证据。 SECURITY.md目前未专门说明此24字符指纹取舍；文档缺项不等同已证泄漏事故。 | 若保现设计，SECURITY/审计合同明确24字符构成、用途及读取权限边界；审计接口/导出遵守最小权限。；合成issue/rotate审计断言不含完整raw token/密文解密值；仅允许已决定的hint，并验证非授权读者不能经对应实际审计入口读取。；若决定改用不可逆/更短hint，明确历史审计兼容；不自动轮换生产secret/token或回写历史数据库。 | [kiwi-catalog/kiwi_catalog/services/merchant_tokens.py:174](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/services/merchant_tokens.py:174)<br>[kiwi-catalog/kiwi_catalog/services/merchant_tokens.py:240](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/services/merchant_tokens.py:240) |
| 3-63 | 部分成立/需收窄 | API owner HMAC、accounts商户token Fernet派生和enrollment稳定grant都使用KIWI_CATALOG_OWNER_TOKEN_SECRET。owner/enrollment消息前缀与Fernet盐/旧派生前缀各自区分用途，未发现仅拿一种合法输出即可直接伪造另一类的证据；但根secret实际失陷会影响三用途。 源代码的根密钥复用及恢复/轮换耦合，不是声称已读取到弱secret或生产泄露。 48中的授权/发grant字段清理没有拆分这三处密钥来源。 不因记录架构取舍直接换env名：存量Fernet密文、legacy HMAC和未完成enrollment都需兼容/迁移方案。 | 若保共用根secret，明确三用途/信任域/失陷半径和高熵配置、轮换恢复边界，保现域分隔。；若决定拆分，先给版本化密钥/旧密文解密兼容/既有legacy凭据与pending grant处理方案，再用合成数据验证新旧读取和新签发。；不得在仅文档裁定阶段轮换secret、破坏旧密文或实际迁移生产DB。 | [kiwi-catalog/kiwi_catalog/api/auth.py:177](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/api/auth.py:177)<br>[kiwi-catalog/kiwi_catalog/services/accounts.py:99](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/services/accounts.py:99) |


### 经理建议与排期（2026-10-09）

以下为建议，未执行22项产品修改。建议先完成当前33项，再安排9项小加固与策略文档；性能项先测量，密钥拆分先兼容设计。22项没有足够证据单凭原描述新增Buddy发布硬门。

| ID | 分类 | 收窄后的事实 | 推荐方案与边界 |
|---|---|---|---|
| 2-17 | 明确策略 | Origin额外检查仅在头和allowedOrigins都存在时执行，但写路径先核session绑定CSRF；cloud实际传publicOrigin。不能把无Origin或省allowlist直接叫管理写认证绕过。 | CSRF为主门，cloud显式Origin允许列表；合法无Origin调用仍须CSRF，不能一律拒绝。 |
| 2-18 | 明确策略 | Connect未知/崩溃锁与effectStarted后不确定claim保留阻断；当前缺面向运维的权威对账与恢复流程。 这是刻意fail-closed安全选择，不是一次任意网络抖动都永久砖死；已知未开始效果/read-only失败可自动释放。不能建议按PID/TTL删unknown锁/claim。 | 优先补人工对账/恢复流程，绑定原enrollment和operation、权威效果证明及恢复权限；unknown不得按PID/TTL清锁重驱。 |
| 2-25 | 先测量 | operations.json保留操作及幂等/对账状态，读写全量JSON且记录持续增长是容量债务；本轮未测得磁盘/延迟故障，不把缺GC称当前安全漏洞。 | 合成长历史测operations.json大小/延迟/内存，再定分段归档阈值；保pending/unknown及幂等tombstone。 |
| 3-1 | 明确策略 | 恢复模块revisionChanged实际比task state字符串，并把所有localSent含本轮已replayed列为stale；返回/未来expireStale语义与“revision变化”名义不一致。 src没有生产NegotiationRecovery实例化或expireStale注入，不能称生产批准必被销毁；需先明确远端revision能力及stale合同。 | 区分state/revision/stale合同；已确认或本轮重放成功不列stale，无revision时诚实unknown；不自动作废批准。 |
| 3-6 | 先测量 | FileLeaseStore journal长期保留claim/renew/release；snapshot全目录readdir找最大token，并读当前claim和该token的renew记录，扫描成本随历史增长。 旧“逐一读所有历史文件”不准确；append-only记录维持fencing单调，不能简单TTL删claim或重用token。未做实际规模性能测量。 | 测历史扫描成本再定checkpoint；保最大fencing token、活跃/unknown owner，不TTL删除重用token。 |
| 3-12 | 明确策略 | 同TaskPoller对象每次poll都新建生命周期tracker；跨poll无历史观察，非法回退只在单次poll内校验。 多数调用一次就到terminal/input-required；若每poll刻意代表独立观察回合不应直接算生产状态回退bug。先明确复用会话合同。 | 推荐poller按单次回合跟踪，跨轮历史由业务会话维护；文档明确不承诺跨poll状态记忆，避免无界task缓存。 |
| 3-25 | 小幅加固 | 工具schema enum已有约束，DB rule_type CHECK也拒非法值；原“非法规则静默入库且永不触发”在正常schema下不成立。剩余是execute cast及store直调缺统一业务validation错误的纵深/UX问题。 | 统一直调输入校验并返回typed validation；保schema enum及DB CHECK，非法输入零行。 |
| 3-26 | 先测量 | memory检索按principal/status取全量后JS过滤评分，limit只裁输出；有线性成本事实但无本轮规模/延迟故障证据，属于性能改进候选。 | 先测规模与排序等价，优先安全SQL预过滤；禁止任意LIMIT丢候选或改变principal权限。 |
| 3-27 | 小幅加固 | session wrapper依赖appendMessage/_persist/_rewriteFile现有形状；方法缺失的.bind会直接失败，不支持“升级必静默失去0600/no-thinking”断言。kernel streamSimple wrapper只控制cacheRetention，不是thinking防线。 | 增加依赖升级兼容性检查，验证0600与思考内容不落盘；不兼容明确failclosed，不盲改私有API封装。 |
| 3-28 | 先测量 | handoffRuntime非空断言有前置guard；每候选多次events.filter确有重复扫描，不是已证空指针安全故障。 | 低优先级；大事件集证实瓶颈才建一次索引，正常与无handoff路径结果不变。 |
| 3-29 | 小幅加固 | clock normalization对不可解析的可信options.now值调用toISOString会抛RangeError；默认Date时钟合法。不能仅凭lambda声明断言每次open必崩，触发取决于clock何时被调用。 | 非法注入时钟返回明确配置错误并收尾资源；正常UTC语义不变，不当生产P1。 |
| 3-30 | 专项评估 | admission显式校验主库owner/mode/非symlink和上级0700；没有单独sidecar检查是纵深缺口，本轮无WAL/SHM公开泄露证据。 | 先用临时WAL库核sidecar权限/owner/替换；无泄漏实证，不清活跃sidecar，不操作真实库。 |
| 3-35 | 小幅加固 | test-only内存budget adapter对未知lease用传入reservedAmount结算，SQLite adapter拒unknown_lease；这是替身契约漂移，不是生产SQLite预算绕过。 | 以共同adapter契约统一未知/重复lease行为，防止测试替身假绿；不改生产恢复政策。 |
| 3-37 | 小幅加固 | pricing/previews POST先要求管理session与products:read，但不调用CSRF/Origin写guard，仅触发计算。浏览器是否能携cookie跨站触发受cookie/site条件限制，本轮无浏览器攻击证据；不能称订单/支付CSRF。 | 定价预览POST建议复用管理CSRF防护，保session及read权限；限于计算接口，不称订单支付CSRF。 |
| 3-38 | 明确策略 | 管理CSRF附加Origin、WebAuthn精确HTTPS/RP、enrollment签名绑定runtime_origin服务不同信任目的；实现不同本身不是bug，不能统一成同一宽松政策。 | 保管理CSRF、WebAuthn、enrollment各自策略；只可共享语法解析，不统一成宽松规则。 |
| 3-39 | 明确策略 | cloud配置/OAuth允许loopback HTTP自检，但WebAuthn确认严格HTTPS，形成部署能力差异；未证本地HTTP承诺支持全部可信确认。是需明确的功能/安全策略选择，非认证绕过。 | 当前本地HTTP不支持可信确认并提前提示HTTPS；暂不放宽WebAuthn origin策略。 |
| 3-40 | 小幅加固 | 裸MCP handler auth可选；生产merchant-runtime-assembly实际调用assertMerchantMcpAuthPolicy拒无认证nonloopback。缺裸构造器防御不能作已证公网无auth装配。 | 在可识别监听边界拒绝非loopback无认证装配；先核裸handler有无可靠host信息，不能凭不可信Host头作决定；保明确本机合同。 |
| 3-52 | 小幅加固 | signedEnrollment===null已早退，后面else owner-token lookup/register分支不可达；维护性死代码成立，非新增匿名发布漏洞。 | 删除不可达owner-token分支，保signed enrollment早退守卫，不恢复unsigned fallback。 |
| 3-53 | 小幅加固 | 每个成功long-poll周期无条件保存sync state，空轮询也写；写放大是实现事实，未证实时故障。不能只按cursor优化而丢seen变化。 | cursor或seen任一变化才保存；空轮询不写，验证重启去重/游标不退化。 |
| 3-60 | 明确策略 | require_merchant_token先从body owner_token或transport _auth_token选择presented，用于merchant_tokens active随机token；无token行且legacy启用时最终仍调用只读body的require_owner_token。仅Bearer携带legacy HMAC不能通过该fallback；该body-only约定已写在require_owner_token文档，不能把它当已承诺的header支持普遍坏掉。 仅无merchant_tokens行/本地conn=None的HMAC legacy fallback；随机active token的Bearer路径不受此问题影响。 management-descriptor/merchants self读面走随机token解析，不是该legacy fallback，不得将P1-6既有结论重列为新bug。 实际写caller有agent_catalog鉴权和listings owner helper；Header由transport注入_auth_token，body不会因此自动获得legacy兼容。 | 保legacy HMAC body-only并写清双路径合同；新调用用随机token Bearer，不扩legacy入口，不许revoked/rotated降级复活。 |
| 3-62 | 小幅加固 | issue/rotate将token[:24]写入audit_events.details_json。当前token为mkt_加32随机字节urlsafe，24字符含4字面前缀和20个随机base64字符（约120随机bit），并非全token，理论剩余约136bit；不能沿用“前缀就是可用凭据”说法。 只讨论catalog商户随机owner token的签发/轮换审计细节，不是平台merchant_id随机后缀。 源码中审计展示hint明确，但本轮没有证明未授权人能读取该审计面；账号合法返回自己完整token也不是该审计披露证据。 SECURITY.md目前未专门说明此24字符指纹取舍；文档缺项不等同已证泄漏事故。 | 新审计建议不可逆指纹替代较长raw token前缀；定义展示格式和历史兼容，不自动轮换token或回写旧审计。 |
| 3-63 | 专项评估 | API owner HMAC、accounts商户token Fernet派生和enrollment稳定grant都使用KIWI_CATALOG_OWNER_TOKEN_SECRET。owner/enrollment消息前缀与Fernet盐/旧派生前缀各自区分用途，未发现仅拿一种合法输出即可直接伪造另一类的证据；但根secret实际失陷会影响三用途。 源代码的根密钥复用及恢复/轮换耦合，不是声称已读取到弱secret或生产泄露。 48中的授权/发grant字段清理没有拆分这三处密钥来源。 不因记录架构取舍直接换env名：存量Fernet密文、legacy HMAC和未完成enrollment都需兼容/迁移方案。 | 长期建议分用途密钥及轮换周期；先版本化/new-old解密/legacy凭据/pending grant兼容设计；不得只换env或轮换生产secret。 |


</details>

## 待补证（3项）

| ID | 原裁定 | 当前收窄描述 | 最低验收标准 / 下一步 | 当前源码定位 |
|---|---|---|---|---|
| 2-29 | 证据不足 | 每IlinkClient实例复用一个client_id是源码事实；服务端是否把不同消息当重复、是否丢第二条缺官方合同/实际证据，本轮未联网。 | 先取得官方client_id语义与逻辑消息重试要求；再用合成客户端验证新消息不同ID/同逻辑重试稳定ID，不能先认定丢消息或盲每请求换ID。 | [kiwi/src/weixin/ilink-client.ts:91](/Users/jianghaidong/coding/kiwi/src/weixin/ilink-client.ts:91)<br>[kiwi/src/weixin/ilink-client.ts:256](/Users/jianghaidong/coding/kiwi/src/weixin/ilink-client.ts:256) |
| 3-2 | 部分成立/需收窄 | 默认恢复只查询taskIds最后一个，缺省message_ids仅远端最新status.message；多task/history事实能否完整恢复未有当前场景证据。 API可能仅提供latest view，未证明实际消息丢失或带缺口成功resume；不能把读取范围限制直接等于生产数据丢失。 | 补明确多task/多远端消息崩溃窗口证据，并区分对端提供哪些history。；若当前能力不能证明完整，应reconciliation_required或声明latest-only，而非假完全恢复；有完整history能力时核对全部任务事实。 | [kiwi/src/negotiation/recovery/recover.ts:106](/Users/jianghaidong/coding/kiwi/src/negotiation/recovery/recover.ts:106)<br>[kiwi/src/negotiation/recovery/recover.ts:352](/Users/jianghaidong/coding/kiwi/src/negotiation/recovery/recover.ts:352) |
| 3-20 | 部分成立/需收窄 | 非Catalog托管agent_card_url抓取会附deps.headers；未绑定该URL与candidate.merchant.domain。生产a2a negotiate可注入Bearer，因此存在条件性跨来源头发送路径。 源码路径存在，但恶意候选可控性、Bearer实际权限/有效域及部署使用未证；不能直接统计成已证有效凭据泄露。Catalog托管匿名剥头已正确。 | 补可信候选来源/可控制URL与真实凭据作用域证据后再定漏洞影响。；若加固，敏感头仅发已明确授权的目标origin；第三方card不带，Catalog匿名路径保持；不新增认证系统。 | [kiwi/src/discovery/resolve.ts:377](/Users/jianghaidong/coding/kiwi/src/discovery/resolve.ts:377)<br>[kiwi/src/discovery/resolve.ts:679](/Users/jianghaidong/coding/kiwi/src/discovery/resolve.ts:679) |

## 不成立或不按 bug 处理（8项）

| ID | 原裁定 | 当前收窄描述 | 最低验收标准 / 下一步 | 当前源码定位 |
|---|---|---|---|---|
| 2-15 | 不成立 | 生产A2A节点实际传advertised.hostname作expectedAuthority，verifier比较authority hostname；裸verifier可选参数不足以成立生产跨主机重放攻击。 | 撤回生产默认跨主机重放结论；若评估裸构造器加固，必须另列可信调用方边界并给缺装配实际入口证据。 | [kiwi/src/a2a/node.ts:308](/Users/jianghaidong/coding/kiwi/src/a2a/node.ts:308)<br>[kiwi/src/trust/identity/auth-verifier.ts:209](/Users/jianghaidong/coding/kiwi/src/trust/identity/auth-verifier.ts:209) |
| 2-24 | 设计/现状记录，非已证漏洞 | OwnerSession允许可信进程内宿主注入switches，属于构造配置，不是已证不可信模型/HTTP权限入口；存在源码替代env不等于未授权绕过。 | 撤回漏洞措辞；仅未来出现不可信可设置switches的真实入口时再评估capability，不为本项要求架构重写。 | [kiwi/src/merchant/ai-runtime/owner-session.ts:528](/Users/jianghaidong/coding/kiwi/src/merchant/ai-runtime/owner-session.ts:528) |
| 3-19 | 成立 | selectReusableEnrollment旧helper仍导出，未考虑catalog_origin/generation，但当前生产只使用更完整的selectSession。 是死导出/API卫生现状，不按生产错误选择会话bug；本轮不以旧helper不足修改已正确生产选择。 | 文档标deprecated/限定兼容用途或迁移测试内部化；生产继续核catalog/key/origin/generation。；不得把仅导出事实说成生产复用错误；没有新动态验收要求。 | [kiwi/src/cloud/connect-service.ts:224](/Users/jianghaidong/coding/kiwi/src/cloud/connect-service.ts:224)<br>[kiwi/src/cloud/connect-service.ts:1164](/Users/jianghaidong/coding/kiwi/src/cloud/connect-service.ts:1164) |
| 3-32 | 不成立 | 独立adapter可选择http传输，但真实gateway注册/canonicalInstanceUrl已拒非loopback明文HTTP；原生产公网Bearer明文外泄链不成立。 loopback开发例外不等于公网外泄；adapter独立防御可另建议，不按待完成漏洞统计。 | 保持注册/加载公网HTTP拒绝及HTTPS/loopback显式例外。；如决定独立adapter也限制scheme，按同上游合同加固；不新增认证或宣称修复既有生产泄漏。 | [kiwi/src/merchant-gateway/tenant-registry.ts:52](/Users/jianghaidong/coding/kiwi/src/merchant-gateway/tenant-registry.ts:52)<br>[kiwi/src/a2a/client/url-policy.ts:296](/Users/jianghaidong/coding/kiwi/src/a2a/client/url-policy.ts:296) |
| 3-41 | 不成立 | 注册key为ip、配对key为pair:ip，清理只删一小时外过期条目，无按容量逐出活跃配对桶；原“注册流量挤掉配对限速”不成立。 | 撤回该bug与必须分池建议；若另报限流容量问题需具体新证据。 | [kiwi/src/mcp/merchant-server.ts:363](/Users/jianghaidong/coding/kiwi/src/mcp/merchant-server.ts:363)<br>[kiwi/src/mcp/merchant-server.ts:448](/Users/jianghaidong/coding/kiwi/src/mcp/merchant-server.ts:448) |
| 3-46 | 设计/现状记录，非已证漏洞 | 2.5秒SIGKILL兜底防wrapper被supervisor杀后子进程孤儿/双实例；可能截断优雅请求属于故障模型，不是应删除兜底的bug。 | 改正文档“正常永不升级”过强承诺；保有界终止，未知效果按已有恢复边界处理，不拿移除SIGKILL当保证。 | [kiwi/src/supervisor/wrapper.ts:98](/Users/jianghaidong/coding/kiwi/src/supervisor/wrapper.ts:98) |
| 3-65 | 设计/现状记录，非已证漏洞 | fallback_asgi对顶层__html__将字符串原样发text/html，不做HTML转义；有no-store/nosniff/no-referrer及CSP frame-ancestors none。该CSP仅限制嵌入框架，不是script-src沙箱或消毒。当前包内仅见marker消费与extension约定，未见内建实际HTML生成caller；未读取真实扩展/配置，不能判当前存在或不存在XSS。 仅fallback扩展的可信HTML响应约定；普通JSON中的嵌套用户字段不会因这个顶层marker自动成为HTML。 旧portal已不在内建代码；不重报已删除载体，也不把有CSP误当任意HTML安全。 FastAPI扩展自行注册响应属于其责任边界，不由此推断所有栈自动转义。 | 文档明确__html__必须由可信HTML producer使用，非可信插值由producer转义/模板处理；区分frame-ancestors与脚本执行控制。；如果将该项作为实际漏洞修复，必须先指出一个真实加载/内建producer及非可信数据→顶层HTML的准确链；再做对应合成输入和响应检查，不能仅扫描marker即宣称XSS。；无需因仅保留可信扩展hook而删除全部HTML能力或添加生产扩展/网络验证。 | [kiwi-catalog/kiwi_catalog/api/fallback_asgi.py:250](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/api/fallback_asgi.py:250)<br>[kiwi-catalog/kiwi_catalog/api/fallback_asgi.py:271](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/api/fallback_asgi.py:271) |
| 3-69 | 设计/现状记录，非已证漏洞 | publish_listing用actor.startswith(runtime:)选择容量校验，reinstate_listing用actor==admin决定可越governance_hold。实际HTTP caller由admin鉴权、merchant token或runtime binding签名验证后生成actor；未见直接把payload.actor传入service。因此字符串合同脆弱是可维护性/内部误用风险，不能直接叫匿名/商户可自称admin提权。 业务service的内部调用者类型表达；有源码认证入口支撑，不是凭字符串自行认证。 publish已有governance_hold直接拒，reinstate还校验merchant归属/owner状态，账号商户容量另有检查；不能概括所有治理/容量都只看actor。 48中CLI审计声明调整没有将此service的actor替换为显式capability/caller_kind；但没有因此新增HTTP外部可控actor证据。 | 文档或类型合同明确actor仅审计身份还是策略调用者；若改显式caller_kind，保现所有caller认证/签名先行和行为矩阵。；合成HTTP尝试payload actor=admin/runtime不得改变鉴权身份或绕governance_hold；真实admin可按现策略reinstatement、runtime签名caller仍过容量，legacy例外按明确开关。；内部service改类型时保证publish/reinstate各治理/容量分支覆盖，不扩成新授权架构或据此对生产做放行。 | [kiwi-catalog/kiwi_catalog/listings/service.py:127](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/listings/service.py:127)<br>[kiwi-catalog/kiwi_catalog/listings/service.py:241](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/listings/service.py:241) |

## 已收尾48项（不重复派修）

[最终验收报告](/private/tmp/kiwi-original48-final-acceptance-20261008/REPORT.md) · [逐项证据矩阵](/private/tmp/kiwi-original48-final-acceptance-20261008/MATRIX.json) · [联合接缝独验](/private/tmp/kiwi-a355-original48-final-independent/REPORT.md) · [提交独立复核](/private/tmp/kiwi-a357-commit-independent/REPORT.md)。

提交：Kiwi `a7c34b17d0197be01838490344901e8955c606d5`（54文件），kiwi-catalog `429f547e7f0a1922ca1cbecdf6fcc3f2964d0534`（34文件）。未push；本文件本次更新也尚未提交。

| ID | 原发现裁定 | 收尾范围（保留风险见最终报告） |
|---|---|---|
| P1-1 | 成立 | 成立；真实buyer-api CLI默认loopback可改host，无auth；商家ops需显式merchant-tokens+marketplace-url；Host/body缺口 |
| P1-2 | 成立 | 成立；limits未执行、ASK task/digest不绑、不消费；候选主要reply_text无结构价 |
| P1-3 | 成立 | 成立、高优先。cloud/onboarding/catalog-pipeline.ts:181-196 readEnrollmentStore后整文件write同 enrollmentStorePath，292/304/320/351/390/396等调用；connect-service.ts:1406-1439有锁+CAS；binding/enrollment-challenge.ts:204-225有锁写consumed；bootstrap:680-710每30s reconcileBinding。可覆盖consumed及并发创建sessions/operation_claim/store_revision。 |
| P1-4 | 部分成立/需收窄 | 提交异常可能留下未知结果；已知发送前失败与发送后丢响应必须区分，不能统称claim泄漏。 |
| P1-5 | 成立 | 成立；`api/handlers/agent_catalog.py:129-143,229-245,958-967` 的旧 list、merchant list、`/v1/agents` 均调用 repository list；`sqlite_repository.py:610-660` 用 `catalog_query.agent_list_cursor_clause:78`（id > 原 cursor），SQL 却是 rank→verified desc→name→id，`pagination.paginate_agent_rows:106` 返回 v2。标准 cagt_ ID 与 v2 比较使第二页空；legacy ID 又不能代表排序边界。 后续原冻结核实catalog last_verified_at当前NOTNULL、未知是空字符串，None仅类型合同/未来投影防御；不据此断言生产NULL数据页必坏。 |
| P1-6 | 成立 | 成立，严重性取决于部署日志/凭据使用；`handlers/cloud_binding.py:87-94` header `_auth_token` 优先，无 header 才 query；`route_table.py:582-593` 共享 wrapper 恒加 allow flag，`fastapi_routes.py:579-588` 真实生产 GET 调用同 wrapper。不是无认证绕过，是同一随机 merchant token 增加 URL 暴露通道。merchant self `handlers/merchants.py:55` 明确 query 优先；listings `handlers/listings.py:334-399` query legacy 被允许，但 binding-signed 请求+query 明确拒绝，account token 还受 migration/account 限制，不能说全部 owner 凭据通用。 |
| P1-7 | 部分成立/需收窄 | 冻结旧锁依赖存在已知公告，不等于当前应用可被利用；MCP OAuth client公告不能泛化到server/stdio。 |
| 2-2 | 不成立 | 不成立：handle顶部统一actionToPhaseEvent/advancePhase已处理scope=offer；报告只看body清理漏了上层。后续补丁重复推进的回归是修复问题，不是原缺失。 |
| 2-3 | 成立 | 成立。rfq→offer(:840-864)、offer→counter(:900-923)不存可接受terms，只有counter→conditional(:1059)存；accept:1113-1129仅该map。KNP §15引用active offer-like不限conditional。 |
| 2-4 | 部分成立/需收窄 | JCS的-0和正指数+确有偏差；1e30被写成1e30而非1e21，负指数本来正确。影响是规范化跨实现一致性。 |
| 2-5 | 部分成立/需收窄 | 原顶层剔除四种字段及重建丢未知字段违背摘要/顶层schema规则；payload内同名业务字段原本并未被剔除。 |
| 2-6 | 成立 | 成立。a2a/negotiate.ts:251-257裸cast提取，375-388未验证conditional，evaluator输入as never；dealPrice undefined能跳过预算。 |
| 2-8 | 成立 | 成立。ledger/store:151-155仅mtime>30s抢占，172-180 finally无owner compare。暂停活进程可与接管者并行且删除新锁。 |
| 2-9 | 成立 | 成立，但仅cross-process同目录；pipeline module锁仅同进程。idempotency/store:149-174 read再rename不是独占，markInFlight同digestexisting还直接return，pipeline:444前置read也有竞态。 |
| 2-11 | 成立 | 成立资源债务；settled/released Map增长，删除须保幂等/对账 |
| 2-12 | 部分成立/需收窄 | 异常组合是幂等事件已存在但link缺失或键冲突，不是每次重放均双COMMIT。原返修仍有COMMIT后抛错被ROLLBACK错误遮蔽。 |
| 2-13 | 成立 | 成立；heartbeat启动后record失败，prepare决策/analysis异常漏释放 |
| 2-14 | 部分成立/需收窄 | expires分支区别于无expires的maxAge符合已有验证语义；未设最长签名窗口是硬化需求，不等于已证明nonce重放利用。 |
| 2-21 | 成立 | 成立；解封预算写condition_json并进入notification/taskevents/TUI |
| 2-22 | 成立 | 成立；shortlist缺manualAdvice直接写candidate/event |
| 2-23 | 成立 | 成立；finally release异常覆盖成功snapshot |
| 2-26 | 成立 | 成立；Caddy先spawn、node失败没有cleanup |
| 2-30 | 成立 | 成立（源码条件 smtp 配好且发信成功）；不是任意内容SMTP中继；`route_table.py:310,330`公开→accounts handlers register:136-148、resend:240-256，仅 email bucket；`services/accounts.py:526-595` 新账号+shadow merchant+entitlement+revoked token→issue_verification:241-258→smtp固定模板:201-231。旋转邮箱可增行/发模板；resend只已有未验证账号；无配置与SMTP失败会回滚。 |
| 2-31 | 成立 | 成立；不可简单按kind拆并发；`services/agent_verification.py:1327-1349`在途去重仅agent，verify在途→refresh得到同task；wait=True返回实际verify kind，wait=False伪填请求kind。refresh handler→_enqueue_verification:407，显式refresh语义被折叠。 |
| 2-32 | 部分成立/需收窄 | 崩溃processing长期占键是运维缺口；时间过期不是未产生外部效果的证据。 |
| 2-33 | 成立 | 成立；`pagination.decode_agent_cursor:53-68`只len4，dict/list作为rank/name进入 `agent_cursor_predicate` params；search repository:587-605 conn.execute→ProgrammingError。旧`/v1/agent-catalog/agents/search`及`/v1/agents/search`公开查询真实用该谓词；plain list当前未decode只比较v2字符串。 后续原冻结核实catalog last_verified_at当前NOTNULL、未知是空字符串，None仅类型合同/未来投影防御；不据此断言生产NULL数据页必坏。 |
| 2-34 | 成立 | 成立但当前默认安全行为无降级；`discovery/fetcher.py:402-406` https_open传self._context，`:305`connect另建default ctx覆盖。当前_build_opener无公共custom CA配置，属于custom context契约/性能债务。 |
| 2-35 | 成立 | 成立；fetcher `_make_request:726-729` Host固定hostname，未用port；allowed_ports允许8443（policy）；urllib explicit Host阻止stdlib自动带port。IPv6还需[]。 |
| 2-36 | 成立 | 成立；60s+只是示意不是硬最坏上限；fetcher `_make_request:745` opener.open才开始网络，redirect_request:339-354每跳validator解析，`_resolve_and_validate:238` getaddrinfo没有deadline；`_process_response:792`到body读取才创建30sdeadline。 |
| 3-3 | 成立 | 成立（资源保留）。idem/store:273前缀排除inflight，readInFlight:198-199 stale仅忽略不删。 |
| 3-4 | 部分成立/需收窄 | shape损坏被当缺失成立；非法JSON原来直接抛异常，不是全部损坏均fail-open；Ledger已有同sender/id事实还有兜底。 |
| 3-5 | 成立 | 成立。ledger:201-212/idem:97-108/context-map:98-109 fsync file无directory fsync（tmp失败也可能残留）。 |
| 3-9 | 成立 | 成立但顶层extension不是schema允许。schema.json:7顶层additionalProperties false，payload money/offer/etc additionalProperties true；objects:140-152重建及common money重建丢payload合法extensions，再pipeline:398/406对重建对象verify导致digest mismatch。 |
| 3-10 | 部分成立/需收窄 | declined原来已经落账、清标记、可重放；原报告这部分不成立。error/throw残留可能是在保护未知效果。 |
| 3-11 | 部分成立/需收窄 | 订单upsert可重绑定来源需加固，但只读是消费者权限；订单status等业务事实可以更新，不要求整个订单表append-only。 |
| 3-15 | 部分成立/需收窄 | 条件求值协议异常被归为internal错误有语义缺口；当前正常作者生成条件未证明会冲突，legacy恢复等输入可触发。 |
| 3-43 | 设计/现状记录，非已证漏洞 | 元数据/JSON404路径事实存在，但无秘密泄漏或反射HTML证据；不能直接归安全漏洞，不需要以此新增修复。 |
| 3-45 | 成立 | 成立buyerinit打印merchant文案 |
| 3-55 | 部分成立/需收窄 | 延迟事务升级有SQLite并发busy风险，但不是所有首开必死锁；v11已有前置DDL可能持写锁。 |
| 3-57 | 部分成立/需收窄 | 仅_persist_running落库前失败造成pending遗留、重启再跑；不是所有running任务都可安全删除。 |
| 3-58 | 成立 | 成立且受状态条件；`handlers/agent_catalog.py:891-905`_moderation_action事务已返回，仅response.verification_status==discovered时enqueue；QueueFull/Shutdown/LedgerError裸抛→500，但reinstate已commit。 |
| 3-59 | 成立 | 成立；报告“所有安装”过度；`db/session.py:34`VERSION0.5.0与package0.5.3；init_db:117写meta。新库/需要init旧库写错；已有current schema打开不会改meta，因此并非所有>=0.5.1安装都必然读错。 |
| 3-61 | 部分成立/需收窄 | authorize的grant入参确为死参数；handler与service重复user_code校验是纵深防御，不是bug。 |
| 3-64 | 成立 | 成立；公共resend accounts:257 unknown email与已存在未verified返回ok；存在verified还单独email verified，forgot:299-303统一返回不同。 |
| 3-66 | 部分成立/需收窄 | 本地CLI把未核token写作admin造成审计归因不准；本地用户已可直接访问DB，不是远程admin认证绕过。 |
| 3-67 | 成立 | 成立，畸形存量/手动注入前提；public GET runtime-binding→handlers/cloud_binding.read_runtime_binding_document:67→binding_claims:178 datetime.fromisoformat无ValueError捕获；naive date还可TypeError比aware。非匿名直接任写绑定expiry证明。 |
| 3-68 | 部分成立/需收窄 | card_digest prefix+长度缺hex验证是防御缺口；签名/enrollment guards已有实际保护，未证匿名任意digest注入。 |
| 3-70 | 部分成立/需收窄 | 未锁安装缺版本floor是依赖治理风险，已有lock/require-hashes保护；不是当前锁内依赖已被利用。 |

注意：3-3保unknown等待权威对账是安全设计，资源残留仍在；P1-4落盘失败halt限同kernel生命周期；2-8需统一新guard写者、guard崩溃有界停止；3-5没有真实掉电证明。收尾不表示这些边界已消除，更不表示48个漏洞全部修复。3-56属于原48以外的超时提交竞态，不与已收尾2-31关停死锁混为一项。

## 历史原始审查（2026-10-07，非当前待办）

> 下列内容保持原字节，包含已修、已撤回和已收窄的旧主张，特别是“7个P1需要立即修复”等语句仅描述旧基线。修复范围必须以上方当前裁定为准。

<details>
<summary>展开原始审查全文（Kiwi 4751d4b / catalog 2252517）</summary>

# 全库代码审查：kiwi @ `4751d4b` + kiwi-catalog @ `2252517`

- 执行者：ZCode（8 路并行只读审查覆盖全部源码模块，P1 断言逐条实读交叉抽验）
- 日期：2026-10-07
- 审查范围：
  - `~/coding/kiwi` @ `4751d4b`（main）— src 约 13.5 万行 TypeScript，432 个源文件，288 个测试文件
  - `~/coding/kiwi-catalog` @ `2252517`（main）— kiwi_catalog 约 3 万行 Python（119 文件）+ 80 个测试文件（2.4 万行）
  - 排除：`wt/` worktree、`dist/`、`build/`、`node_modules/`、`__pycache__/`
- 前置衔接：A263（Buddy 应用增量审查，同日）的全部发现做了修复状态复核（见 §4）
- 性质：只读 code review，零改动
- 验证声明：kiwi-catalog 测试套件实跑通过（`uv run pytest` 913 passed + 72 subtests，77s）；kiwi 未跑全量测试套件，仅审查过程中随跑 5 个相关测试文件（65 用例通过）；标注「已抽验」的条目为汇总者本人实读代码复核，其余条目来自模块审查的实读报告。

---

## 0. 核心结论（TL;DR)

两个库的工程纪律整体显著高于平均（fail-closed 导向、审查编号注释可追溯、测试真实有效、mock 克制），**但有 7 个 P1 需要优先修复**：

- kiwi 侧最严重的是**旧的 buyer HTTP API 完全无认证**（与周围层级的认证纪律严重脱节，是当前唯一必须立即修的面）和 **buyer 委托策略的硬约束层空转**（价格/商家/货币上限全不执行）。
- kiwi-catalog 侧是**公开 list 端点翻页永远停在第一页**（已端到端实证）与 **GET 凭据进 URL**（与自身 fail-closed 注释矛盾）。
- A263 的两个 P1（connector pin、public binding 验签）已确认修复；但同类的跨进程并发问题**漏了一个写入方**（catalog-pipeline，本次新 P1），另有 6 项 A263 P2 级遗留未修。
- 横切：kiwi 生产依赖有 2 个已知漏洞（1 critical + 1 high），`npm audit fix` 可解。

统计：**P1 × 7、P2 × 36、P3 × 71**。两库共同的系统性弱点：①跨模块**异常收尾路径**（claim 释放、事务窗口、锁清理）正常路径全覆盖但修法不一；②**文档化纪律与实际行为漂移**（注释声称的不变量被实现绕过）；③**长期运行的状态泄漏**（只增不删的 Map/JSON 日志/幂等行）。

---

## 1. P1 — 应立即修（7 项）

### 1.1 kiwi

#### P1-1 · buyer HTTP API 全部变更端点无认证（已抽验）

- **位置**：`src/http/server.ts:168-241`（路由表）、`:245`（Host 拼接）、`:51-67` 与 `:261`（body 限制）
- **发现**：`kiwi buyer-api serve` 的全部路由无任何认证中间件——`POST /tasks/:id/negotiate`、`POST /approvals/:id/approve`、`GET/POST /merchant/:id/*` 直接可调。最重的是 `POST /merchant/:id/resolve-review`（:208-215）：无认证调用方可借服务端从 merchant-tokens.env 加载的 merchant token（`src/cli.ts:94-103`）对 marketplace 执行**商家侧人工审核裁决**。且 `:245` 直接把 `req.headers.host` 拼进 URL 基座、无 Host 校验，可被 DNS rebinding 打到缺省 loopback 监听（`cli.ts:87` 缺省 127.0.0.1，`--host` 可覆盖）。
- **配套问题**：`readJson` 超限 reject 后不移除 `data` 监听、不 `req.destroy()`，后续 chunk 继续累积 → 单个未认证请求可流式灌大 body 打满内存；且 `:261` `.catch(() => ({}))` 把 413/JSON 解析失败静默吞成空对象，路由照常执行——大小限制形同虚设。
- **建议**：至少加 Bearer 凭证 + Host allowlist；管理/商家操作端点单独凭证；超限即销毁连接并把 413 传播到路由层。修复时同步补测试（现仅有 http-adapter happy-path）。

#### P1-2 · buyer 委托策略硬约束层空转（已抽验）

- **位置**：`src/buyer-core/service.ts:938`（`limitViolation`）、`:860-901`（ASK 审批）、`:851`（merchant_hard_policy）
- **发现**：`limitViolation` 只执行了 `deadline` 和 `payment` 两项；DelegationPolicy 声明的 `max_total_price` / `max_unit_price` / `max_quantity` / `allowed_merchants` / `allowed_currencies`（:249-254 定义）在 `acceptAgreement` / `negotiate` 路径完全没有执行，`merchant_hard_policy` 层无条件 `"allowed"`。**带价格上限的委托策略可以批准任意价格的 accept**。
- **同族问题**：ASK 审批接收 `opts.candidateDigest` 但从不与 `approval.candidate_digest` 比对（对照 `src/auth/merchant-oauth.ts:656` 是有比对的），也不检查 approval 所属 task 与当前 task 一致；且 `approved` 状态无一次性消费——同一 approval_id 可反复授权 accept，换掉候选内容（同 task 不同 candidate）审批依然放行，违反候选绑定重验的设计意图（`action-candidate.ts:29-30`）。
- **建议**：`limitViolation` 对 accept 类动作核对候选价格与 limits，未解析到的约束显式 deny 而非静默跳过；校验 `approval.task_id === opts.taskId` + digest 一致；授权消费后置为 used。

#### P1-3 · enrollment store 漏锁写入方（已抽验）

- **位置**：`src/cloud/onboarding/catalog-pipeline.ts:181`
- **发现**：`saveWorkbuddyEnrollment` 对 merchant-enrollments.json 做裸 read-modify-write，**不走 `withEnrollmentStoreLock`、不递增 store_revision**（全仓 grep 确认该锁只在 `connect-service.ts:1406` 使用）。bootstrap.ts:708 的 30s `bindingReconcileTick` 驱动它写同一份 0600 JSON，与持锁的 challenge responder（写 consumed[] 防重放）和另一进程的 `kiwi merchant connect` 并发时可整文件回写覆盖：轻则丢失 CLI 新建会话、触发 STATE_CAS_CONFLICT 风暴，重则把 challenge responder 刚消费的 consumed 记录回滚，制造 60s 挑战重放窗口。这正是 f0c917e「authenticate Connect bindings and serialize enrollment effects safely」声称修掉的那类问题，此写入方被漏掉。
- **建议**：`saveWorkbuddyEnrollment` 改走 `withEnrollmentStoreLock` + CAS（或并入 connect-service 的 persist 路径）。

#### P1-4 · autopilot submit 失败后 claim 滞留

- **位置**：`src/agent/kernel.ts:1280-1281` + `src/operator/runner.ts:353-356`
- **发现**：`runner.submit(prepared).catch(() => undefined)` 吞掉 `submitNegotiationDecision` 的网络异常且从不调 `runner.abandon`；`submit` 内部只有成功/策略拒绝两分支处理 claim（completeClaim/failClaim），异常路径裸抛。同仓 `negotiation-chat.ts:254-265` 已修同款问题（"claim 成功后任何瞬时失败不得让 claim 滞留 processing 直到网关 300s stale TTL"）——chat 路径修了、kernel 自动 tick 主路径漏修。15s 一次的 tick 期间 `listPendingMessages` 不再返回该消息，"下一轮自动重试"的提示不成立。
- **建议**：kernel.ts 该 catch 内 best-effort `runner.abandon(prepared, ...)`。

### 1.2 kiwi-catalog

#### P1-5 · 公开 agent list 端点翻页永远停在第一页（已抽验，端到端实证）

- **位置**：`kiwi_catalog/agent_catalog/catalog_query.py:78-85` + `sqlite_repository.py:610-656` + `pagination.py:106-113`
- **发现**：`list_catalog_agents` / `list_catalog_agents_by_merchant` 的排序键是 rank-first（`AGENT_ORDER_BY`），但游标谓词只有 legacy 单键 `ca.catalog_agent_id > ?`（`agent_list_cursor_clause` 原样传游标串），而 `_paginate_agent_rows` 恒发 v2 四元组游标（`v2:...`）。`'cagt_...' > 'v2:...'` 恒假 → 实测 `GET /v1/agent-catalog/agents` 带 `next_cursor` 翻页返回**空页且 next_cursor=None**，数据永远取不到第 1 页之后；即使客户端传 legacy id 游标，也与 rank-first 排序不同键，跨 rank 组会重复/丢行——正是 §8.3 注释里点名的历史 bug 类 P1-6，只修了 search 半边。讽刺的是 `catalog_query.py` 头注释声称排序键与 `pagination.agent_cursor_predicate`「never drift apart」。
- **建议**：list 入口改用与排序键同源的 `pagination.agent_cursor_predicate`，并补翻页端到端测试（该 P1 因此漏网——agent list 端点翻页无任何端到端测试）。

#### P1-6 · management-descriptor 接受 URL query 里的 owner_token（已抽验）

- **位置**：`kiwi_catalog/api/handlers/cloud_binding.py:91`（配合 `api/route_table.py:582-593`）
- **发现**：代码注释称 query 回退「仅兼容本地 fallback 旧约定；生产 FastAPI 路由不设置该标记」，但 route_table.py 的共享 wrapper 无条件注入 `_allow_query_owner_token: True`，而 `fastapi_routes.py:579-588` 正是 import 该 wrapper——注释描述的漂移已实际发生。GET 请求凭据进 URL 意味着代理日志/浏览器历史/中间层缓存暴露完整商家凭据（access_log 的 query_summary 有脱敏，但管不住链路中间层）。同族：`/v1/merchants/self?owner_token=…`（`handlers/merchants.py:55`）与 `/v1/agents/{id}/listings` 自查凭据同样经 URL query，量级较小。
- **建议**：删掉该 query 回退，或如实承认暴露面并默认关闭；把「凭据不进 URL」收口为单一清单。

### 1.3 横切（依赖）

#### P1-7 · kiwi 生产依赖已知漏洞（已抽验）

- **发现**：`npm audit --omit=dev` 报 2 项：
  - `proxy-addr` 1.1.0–2.0.7 — **critical**，IPv4-mapped IPv6 信任子网 IP 欺骗（GHSA-jqcg-44mw-7w3h）
  - `@modelcontextprotocol/sdk` 1.30.1 — **high**，OAuth client 可向 MCP server 选择的授权服务器发送凭据（GHSA-6qxp-vccf-f47h）
  - 均有 `npm audit fix` 可用的修复版本。
- **建议**：升级并回归 MCP 工具面测试。kiwi-catalog 侧锁文件抽查正常（cryptography 50.0.0 / fastapi 0.141.1 / starlette 1.6.0，均为当前安全线），本机无 pip-audit 未做全量依赖漏洞扫描（见 §9 未验证事项）。

---

## 2. P2 — 建议尽快修（36 项）

### 2.1 协议多主体与互操作（kiwi a2a / negotiation）

| # | 发现 | 位置 |
|---|---|---|
| 2-1 | 磋商状态（phaseStateByNegotiation/conditionalByNegotiation/closedNegotiations）只按 `negotiation_id` 键控，`handle()` 全程不校验 `ctx.senderIdentity` 与 `envelope.actor`：任意通过认证的调用方可对他人谈判的在售 conditional 发 `accept_nonbinding` 并产出 agreement，违反 KNP §15。建议 accept 及 offer 类动作绑定 sender/actor，negotiation 首次出现时把 owner 固化进相位状态 | src/a2a/server/merchant-handler.ts:702-710, 314-334 |
| 2-2 | `withdraw`/`decline` 的 `scope=offer` 分支只删 conditional、不调 `advancePhase`：§21.2「Withdraw scope=offer → OPEN」不生效，相位停在 OFFER_OPEN、active_offer_id 残留、无 state_transition 落账；此后买家重新发 offer 被 `applyOffer` 以 state_conflict 拒绝 | src/a2a/server/merchant-handler.ts:1217-1236 |
| 2-3 | `accept_nonbinding` 只认 counter_offer 分支（:1059）登记的 conditional_offer：rfq→offer、offer→counter_offer 产生的普通 offer/counter_offer 从不登记，买方接受商家直报价必得 `offer_unknown`，对外部合规实现是互操作断裂（§15/§21.2 主路径） | src/a2a/server/merchant-handler.ts:1112-1128 |
| 2-4 | JCS 与 RFC 8785 不符（已核对 RFC 原文）：`-0` 应序列化为 `"0"`（实现返回 `"-0"`）；正指数应保留 `+`（`1e30` 规范为 `"1e+30"`，实现剥成 `"1e21"`）。jcs.test.ts:16-17 的错误注释把偏差锁进了测试。内部自洽不受影响，但任何标准 JCS 库算出的 digest 都不同——contentDigest、envelope digest、terms_digest、policy_digest、agreement 重验的**跨实现互操作全部断裂**（触发条件：≥1e21 或 <1e-6 的数）。当前值均为整数 minor units，属潜伏风险 | src/negotiation/jcs.ts:44-54；影响面 src/a2a/server/merchant-handler.ts:241,1146、transaction.ts:268 等 |
| 2-5 | `TRANSPORT_SIGNATURE_FIELDS`（signature/transport_signature 等 4 个）在 digest 计算前从 envelope 内剔除——KNP §19.2 第 7 条明文「MUST NOT invent a local signature-field stripping list inside the KNP envelope」。这四个名字若作为业务内容出现将永远不进 digest | src/negotiation/domain/envelope.ts:35-40 |
| 2-6 | 商家 `conditional_offer` 回复未过 `validateConditionalOffer` 就以 `as never` 强转进入 `evaluateConditionalOffer`：then_terms 的结构/金额（float amount_minor、缺 unit_price）不设防，成交价直接取自未校验数据 | src/a2a/negotiate.ts:388, 417 |
| 2-7 | MCP buyer 磋商路径完全绕过协议基建：裸 `A2AClient` 直发，无 Ledger 落账、无幂等（`buildCounterEnvelope` 每次生成新 message_id，重试即新消息）、无 lease；商家回复经 `extractKnpEnvelope`（a2a-knp.ts:129 裸 cast）未经 `validateEnvelope`/`verifyEnvelopeDigest` 直接采信，与「远端内容 untrusted、fail-closed」不符 | src/buyer-core/a2a-negotiator.ts:177-182（同型 a2a-quote-fetcher.ts:154、build-service.ts:108-109） |

### 2.2 并发与状态一致性（kiwi）

| # | 发现 | 位置 |
|---|---|---|
| 2-8 | `withChainLock` 的 finally 无条件 `unlinkSync`：持有者被陈旧抢占逻辑误判（>30s 停顿未崩溃）后，新进程接管、原持有者退出时会删掉**新持有者**的锁，第三个进程可再进入临界区——两进程同时 load→verify→rewrite 同一链，静默丢失一条事件（正是注释声称「绝不」发生的后果）。建议锁内容写唯一 token、finally 读回比对后再删；stale 判定前先 `process.kill(pid, 0)` 查活 | src/negotiation/ledger/store.ts:172-180 |
| 2-9 | `markInFlight` 是读-改-写（rename 覆盖）非原子 claim：共享目录多进程同时处理同 (sender, message_id) 时两个 marker 互相覆盖、双双通过检查执行 handler；`commit` 只拦异 digest，同 digest 双执行（双报价）无兜底。建议改 `openSync("wx")`，EEXIST 视为「结果未知→对账」 | src/negotiation/idempotency/store.ts:149-174 |
| 2-10 | `runInTransactionAsync` 在 BEGIN/COMMIT 之间 `await input.prepareCandidate(...)`（外部异步接缝）：窗口内同连接的无关写入会并入未提交事务（外层抛错被连带回滚）、读取会看到未提交行。"await 仅微任务桥接"只是注释契约，无运行时强制 | src/merchant-core/rfq/repository.ts:233-247 + release-coordinator.ts:154 |
| 2-11 | `AiRuntimeGate.leases` Map 只增不删：每次 `acquireTurnLease` 都 set，settled/released 记录永不 delete（stats() 只是过滤），长驻 runtime 内存无界增长 | src/merchant/ai-runtime/gate.ts:302, 369 |
| 2-12 | `createConsultationLink` 幂等重放分支的隐藏双 COMMIT：重放时先 COMMIT 后若 link 行不存在会继续执行插入路径，末尾第二次 COMMIT 抛错且 catch 里 ROLLBACK 也抛错、掩盖原始错误 | src/agent/task-store.ts:806-816 |
| 2-13 | `prepareNextCandidate` 先 `startHeartbeat` 再 `record(candidate.generated)`：record 失败时心跳已启动、claim 已持有但候选未入账，消息被永久占住（心跳一直续命，stale TTL 永不触发），只能重启恢复。同型：runner.ts:293-328 `deterministicBuyerDecision` 抛错不经 release 兜底 | src/operator/controller.ts:553-558 |

### 2.3 安全面（kiwi）

| # | 发现 | 位置 |
|---|---|---|
| 2-14 | 带 `expires` 的签名绕过 maxSignatureAge 检查且窗口无上限：`maxSignatureAgeSeconds`（缺省 900s）仅在无 `expires` 时生效，`expires - created` 可任意长，T1/T2 不强制 nonce → 被捕获的合法签名可长期重放。建议对 `expires - created` 加上限（对齐 binding claims 的 15 分钟，claims.ts:32） | src/trust/identity/message-signature.ts:346-351 |
| 2-15 | standalone 形态缺省 fail-open 于跨主机重放（K-M8 复发面）：`authoritySource` 缺省 `"host-header"`、`expectedAuthority` 可选——自托管 A2A 节点未配置时对 host A 签名的请求可重放到 host B。cloud 已设 `declared`，但 a2a/node.ts:313 的透传参数全靠调用方自觉 | src/trust/identity/auth-verifier.ts:94, 167 |
| 2-16 | 登录失败锁定可被持久攻击者变成永久 IP 封锁：失败计数只在登录成功时清零，5 分钟块到期后任何一次失败立即续锁；`clientKey` 是 socket IP，反代后所有管理员共享一个 IP | src/mcp/merchant-server.ts:617-647 |
| 2-17 | Origin 校验是「可静默关闭的门」：仅当 `options.allowedOrigins !== undefined` 时才比对，且请求不带 Origin 头时整体跳过。当前 cloud bootstrap 恒传 `[config.publicOrigin]` 运行态安全，但 API 契约允许部署方不传而无任何告警。建议缺省 fail-closed 或启动告警 | src/http/merchant-management/api.ts:3496-3504 |
| 2-18 | 崩溃恢复路径整体缺失：持锁期间崩溃留下 merchant-enrollments.lock（永不清理，后续一切 persist 抛 ENROLLMENT_STORE_BUSY）；`reserveEnrollmentCreation` claim 文件崩溃后永驻；`operation_claim.state="unknown"` 无任何代码/CLI/API 能清除。fail-closed 设计正确但运营者无恢复工具，一次网络抖动即永久砖死 enrollment。建议提供 owner 级「确认后果并重建」命令或按 PID 存活性清理锁文件 | src/cloud/binding/store-lock.ts:44 + connect-service.ts:1441-1500 |
| 2-19 | `request()` 是全仓唯一违反 net/safe-http.ts 三纪律的出站客户端：无超时（商家 Feed 挂起则 getUpdates 永久卡住）、无响应体上限（`response.text()` 无界）；applySnapshot 的 `while(true)` 分页对恶意商家返回永不 null 的 next_offset 会无限拉取。恶意/被入侵商家可对 buyer 端做资源型 DoS | src/discovery/merchant-subscriptions.ts:326-344（applySnapshot :220-232） |
| 2-20 | `ALWAYS_PRIVATE_KEYS` 用 `serialized.includes('"budget')` 等子串匹配做私钥兜底：SKU 以这些词开头即误报（已复现：`sku:"phone-case-123"` 命中 `"phone`、`"contact-lens-A"` 命中 `"contact`），`buildDisclosedRfq` 直接抛错——常见品类的 RFQ 发不出去。fail-closed 不泄漏隐私但属正确性/可用性 bug。建议只对 JSON key 位置匹配 | src/fanout/disclosure.ts:123, 189 |

### 2.4 agent 模块（kiwi src/agent）

| # | 发现 | 位置 |
|---|---|---|
| 2-21 | 私有预算明文泄漏，违背本模块自己声明的封存不变量：task-store 把 `max_total_price` 封进 Vault、buyer-tools 对模型脱敏，但 `installDefaultRules` 把解密出的预算明文写进 `tracking_rules.condition_json`，`evaluateRule` 把阈值拼进通知 summary——落 task_events、经 chat-tui 打到 TUI，违背 create_buyer_task 工具描述「绝不在任务输出、回复或任何地方回显预算数值」 | src/agent/search-loop.ts:129 + scheduler.ts:396（对照 task-store.ts:122-133） |
| 2-22 | `shortlist_listing` 缺 `manualAdvice` 守卫：manual 模式下其余工具全部拒绝执行，此工具却直接 upsert 候选 + 改状态 + 落事件，绕过 §16「manual 只建议」的统一语义 | src/agent/buyer-tools.ts:1621-1675 |
| 2-23 | `get_negotiation_snapshot` 在 `finally` 中 abandonClaim：snapshot 已成功读取但 abandon 抛错时成功结果被异常覆盖，且无重试、claim 滞留风险与 P1-4 同族 | src/agent/negotiation-chat.ts:314-319 |

### 2.5 merchant 系列与运行编排（kiwi）

| # | 发现 | 位置 |
|---|---|---|
| 2-24 | 双开关仍可被进程内 `switches` 绕过（A263 §3-1 未修）：`input.switches ?? readOwnerSessionSwitches(process.env)`，任何能触达构造器的进程内代码传 `{ownerEnabled:true, aiRuntimeEnabled:true}` 即完全绕过 env 双开关。建议仿照 OwnerStorageAdmission 的 branded-capability 做法 | src/merchant/ai-runtime/owner-session.ts:528 |
| 2-25 | operations.json 无界增长 + 每操作全量重写：converse 每轮新增 OperationRecord 从不清理归档，read/write 每次全量解析/校验/重写，长期运行磁盘与延迟线性退化 | src/merchant/ai-runtime/owner-session.ts:611-646 |
| 2-26 | `cmdMerchantUp` 先 spawn Caddy 再 `await startA2aNode(...)` 无 try/catch：节点启动失败异常直接冒泡，Caddy 子进程被孤儿化，继续持有 80/443 与 TLS | src/cli.ts:2230-2248 |
| 2-27 | `cmdMerchantUp` 内 `SetupPublicError` 未捕获走 `fatal:` + EXIT.TRANSIENT，而 `cmdMerchantSetupPublic` 对同类错误返回 EXIT.CONFIG——同一错误两条路径退出码不一致 | src/cli.ts:2209, 2251-2563（对照 :2552 特判清单） |
| 2-28 | `cmdWeixin` 的 catch 把所有错误（网络超时、session_stale、qr_expired）一律返回 EXIT.CONFIG(2)：脚本按退出码把瞬时故障当配置错误。network 类应归 TRANSIENT(10) | src/weixin/cli-weixin.ts:130-134 |
| 2-29 | `sendMessage` 对所有出站消息复用同一个进程级 `client_id`（构造器生成一次）：若 iLink 服务端按 client_id 幂等判重，同进程第 2..N 条不同内容消息可能被判重丢弃（表现为微信通道「只回第一条」）。**待确认**服务端判重语义（对齐 Hermes weixin.py 应为每消息一个 uuid） | src/weixin/ilink-client.ts:98, 263 |

### 2.6 kiwi-catalog

| # | 发现 | 位置 |
|---|---|---|
| 2-30 | /v1/accounts/register 与 resend-code 只有 per-email 限流、无 per-IP/全局桶：smtp 模式下未认证端点可向任意地址发信，轮换邮箱即构成邮件轰炸/垃圾中继；同时每次注册无界创建 merchant_accounts + 影子 merchants + listing entitlements 行。verify-email/reset-password 已修 H4，此处是同类缺口 | kiwi_catalog/api/handlers/accounts.py:136-148, 240-256 |
| 2-31 | enqueue 去重只按 catalog_agent_id 忽略 kind：已有 pending/running 的 verify 任务时，显式 `enqueue(kind="refresh")` 会直接返回 verify 任务的 outcome 而不执行 refresh（freshness 门短路成 no-op）——显式 refresh 被静默吞掉；返回结果的 kind 字段还填的是请求的 kind 而非实际任务 kind | kiwi_catalog/services/agent_verification.py:1327-1349 |
| 2-32 | 幂等表只清理 `status='completed'` 行：崩溃/重启留下的 processing 行永不清理，而 replay 对 processing 行抛 409——该 (endpoint, actor_key, idempotency_key) 三元组被永久占坑。建议 prune 放宽为 completed+processing 超时即视为死 claim | kiwi_catalog/api/idempotency.py:241-247（replay :177） |
| 2-33 | v2 游标元素无类型约束，匿名可触发 500：`decode_agent_cursor` 只验「4 元素 list」，元素可以是 dict/list → 直接作 SQL 参数抛 `sqlite3.ProgrammingError`，无任何一层捕获 → 公开面 `GET /v1/agent-catalog/agents/search` 500。违反库自己的「畸形 cursor → 4xx」约定（listings/sqlite_repository.py:340 有同款正确实现） | kiwi_catalog/agent_catalog/pagination.py:53-68 |
| 2-34 | TLS context 被静默忽略：`_ProtectedHTTPSConnection.connect()` 每次新建 `ssl.create_default_context()`，丢弃 `https_open` 传入的 `context=self._context`。当前两套都是默认 context 无实际回退，但未来自定义 CA/策略配置会被静默失效，且每连接重建 context | kiwi_catalog/discovery/fetcher.py:305-308（对照 :402-406） |
| 2-35 | Host 头缺非默认端口：显式 `req_headers["Host"] = hostname` 不带端口——`https://host:8443/`（8443 在 allowed_ports 中，是活路径）会发 `Host: host`，非默认端口虚拟主机路由错 | kiwi_catalog/discovery/fetcher.py:726-729 |
| 2-36 | 总时长上限不覆盖重定向链：`_MAX_FETCH_DURATION_SECONDS=30s` 只约束 body 读取；每跳重定向各有 10s socket timeout + 一次无超时 `getaddrinfo`，redirect_limit=5 时最坏 ~60s+ 钉住 fetch 线程。建议 monotonic deadline 贯穿 `_make_request` 全生命周期 | kiwi_catalog/discovery/fetcher.py:104-107 |

---

## 3. P3 — 低优先级 / 记录备查（55 项）

### 3.1 kiwi — 协议与领域

| # | 发现 | 位置 |
|---|---|---|
| 3-1 | `revisionChanged` 只比较 task state 字符串（非 revision）且把全部 localSent 置 stale——包括刚重放成功的消息；远端正常推进也触发。建议基于 revision 判断、只对未确认送达前的消息置 stale | src/negotiation/recovery/recover.ts:584-588 |
| 3-2 | 恢复只 fetch `taskIds.at(-1)`、view.message_ids 缺省只含 task 最新一条消息：崩溃窗口内积压的多条远端消息/多 task 不会进入本地 Ledger，恢复可能带缺口 resume | src/negotiation/recovery/recover.ts:352, 106-131 |
| 3-3 | `sweep()` 只匹配 `idem-` 前缀，`inflight-*.json` 永不清理：崩溃后不再重试的消息 marker 永久残留 | src/negotiation/idempotency/store.ts:273-274 |
| 3-4 | `readRecord` 对损坏文件返回 null → check 判为 new → 已执行消息被重复执行（fail-open）；而 `readInFlight` 对损坏 fail-closed，两套口径不一致。建议损坏记录同样视为「结果未知」 | src/negotiation/idempotency/store.ts:110-128 |
| 3-5 | `writeFileAtomic` rename 后未 fsync 目录（idempotency/store.ts:97-108、context-map/store.ts:98-109 同款）：掉电时 rename 本身可能丢失 | src/negotiation/ledger/store.ts:201-212 |
| 3-6 | lease journal 内 `claim-N`/`renew-*` 文件永不清理，每次 snapshot 全量 readdir + 逐文件读：长期运行性能线性退化 | src/negotiation/lease/store.ts:142-165 |
| 3-7 | `createTask` 是 check-then-insert：并发同 idempotency_key 时 UNIQUE 冲突裸抛（未包装为幂等命中）；`updateTask` 注释称「乐观并发」但无版本号，read-modify-write 会丢并发更新 | src/buyer-core/store.ts:155-163, 224-243 |
| 3-8 | `required()` 恒传 `profile: null`：reconciliation error 事件的 counterparty_identity 恒为 "unresolved"，即使 profile 已解析成功，审计取证丢上下文 | src/negotiation/recovery/recover.ts:257 |
| 3-9 | 运行时校验器只挑已知字段重建对象：携带 schema 允许扩展字段的第三方 envelope 在管线 digest 复核处被拒为 schema_invalid（fail-closed 无安全洞但属互操作断裂面）；且冻结 schema.json 仅在测试执行，契约权威是「测试时」而非「运行时」 | src/negotiation/domain/objects.ts:140-152 + contracts/negotiation/1.0/schema.json |
| 3-10 | handler 返回 declined/抛协议错误时 `markInFlight` 写入的标记不清除：同 message_id 重试此后 24h 一律 reconciliation_required 而非可重放的同义 decline。decline 路径本无对外副作用，应在确定性拒绝后清标记 | src/a2a/server/pipeline.ts:444-457 |
| 3-11 | 「只读订单事实」唯一写路径用 `ON CONFLICT(order_id) DO UPDATE`：同 order_id 重摄取可改写 status/line_items/terms_digest 甚至重绑 agreement_id，与 append-only 审计声明不符。建议同 order_id + 内容 digest 幂等、内容冲突即拒 | src/handoff/order-record.ts:316-331 |
| 3-12 | 每次 `poll()` 新建 `TaskLifecycleTracker`：跨 poll 会话不保留观察历史，非法回退只在同一次 poll 内被拒。建议 tracker 由调用方持有复用 | src/a2a/task/poller.ts:192 |
| 3-13 | 请求前 DNS 复查与 fetch 实际解析之间是经典 TOCTOU，解析出的 IP 未被 pin，DNS rebinding 窗口仍在（缓解已有：redirect:manual、https）。建议自定义 lookup 把复查通过的 IP 固定到本次连接 | src/a2a/client/client.ts:103-108（ucp-checkout/client.ts:199-204 同型） |
| 3-14 | 幂等串行锁表是模块级（跨 InboundPipeline 实例共享）；sweep 节流用 `Date.now()` 而非注入的 `this.now()`。时钟注入纪律不一致 | src/a2a/server/pipeline.ts:159, 367 |
| 3-15 | accept 路径 `evaluateConditionalOffer` 未捕获：evaluator 对冲突规则抛的协议错误到管线被收敛成 -32603 internal error。生产 handler 只产单条件规则实际不可达，属防御缺口 | src/a2a/server/merchant-handler.ts:1132 |

### 3.2 kiwi — cloud / fanout / discovery

| # | 发现 | 位置 |
|---|---|---|
| 3-16 | RFC 8628 access_denied（商家拒绝）无映射（A263 §2-4 未修）：denial 走 RESPONSE_INVALID 或带 remoteCode 的 REQUEST_REJECTED，`stepFailureCode` 在 preparing 阶段无映射，owner 只看到 CONNECT_STEP_FAILED，无法区分「商家拒绝配对」与「其他失败」 | src/cloud/catalog-client.ts:490-503 + connect-service.ts:795-818 |
| 3-17 | 产出 `PUBLICATION_CHECK_FAILED` 但不在任何白名单：CONNECTION_PAIRING_SAFE_CODES 与 workbench 侧 CATALOG_CONNECTION_SAFE_CODES 都没有，owner 摘要被降级成笼统的 CATALOG_CONNECTION_UNAVAILABLE。安全码仍是「connect-service 一份 + api.ts 手工补一份」的双清单（A263 §2-5 未修） | src/cloud/connect-service.ts:552, 745, 861 + http/merchant-management/api.ts:148-154 |
| 3-18 | beforePublish 失败 owner 可见性仍不完整（A263 §2-6）：availability 会置码，但 `bindProductTableToCatalog` 抛出的 ProductTableError 被归并成 CONNECT_STEP_FAILED 且 detail 恒为空串——owner 知道失败不知道为什么 | src/cloud/connect-service.ts:1079-1087 + bootstrap.ts:590-604 |
| 3-19 | `selectReusableEnrollment` 已弃用仍导出且忽略 catalog_origin/generation（A263 §2-9 未动）：生产路径已由 `selectSession` 取代，仅 merchant-connect.ts:47 再导出供迁移测试。建议加 @deprecated 或内移测试 | src/cloud/connect-service.ts:224-240 |
| 3-20 | catalog 候选的 `discovery.agent_card_url`（非 Catalog 托管路径）会携带 `deps.headers`（buyer 对商家的出站凭据）抓取，且不校验与 candidate.merchant.domain 的归属关系：恶意候选可把 buyer 的 Bearer 引到任意第三方主机。**待确认**实际凭据价值；建议非托管候选做同源校验或剥离凭据 | src/discovery/resolve.ts:377 |
| 3-21 | `Date.parse(challenge.expires_at)` 为 NaN 时 `NaN <= nowMs` 为 false：垃圾/超长 expires_at 被当作未过期放行并签名（issued_at 完全不校验）；/control/challenge 消费记录默认进程内存，重启后 TTL 窗口内 proof 可重放。下游 Catalog 会核对，实际风险低，边界宜收紧 | src/cloud/binding/runtime-challenge.ts:194 + proofs.ts:231 |
| 3-22 | `waitForOffer` 轮询循环里 `handle.getState(ref)` 自身无超时护栏：deadline 检查只在每轮开头，通道实现挂起则该腿永久挂住。**待确认** ChannelHandle 是否自带超时 | src/fanout/orchestrator.ts:430-457 |

### 3.3 kiwi — agent 模块

| # | 发现 | 位置 |
|---|---|---|
| 3-23 | 四处幂等键掺 `uuidv7()` 随机量（update-constraints/rule/cancel/shortlist）：模型重试会重复写事件、重复装规则；executeSelection 已按内容寻址键修正，此处是未收敛旧模式 | src/agent/buyer-tools.ts:1003, 1075, 1132, 1662 |
| 3-24 | `redactPrivateFloor` 仅匹配底价的唯一十进制表示：80.5 写作「80.50」因负向断言不命中、不被脱敏（注释自认的纵深防线缺口）。建议数值归一化匹配 | src/agent/negotiation-chat.ts:101-106 |
| 3-25 | `p.rule_type as never` 类型逃逸：addTrackingRule 不校验 rule_type 合法性，非法值静默入库，evaluateRule 的 default 分支静默不触发——规则「装了但永远不开火」且无错误反馈 | src/agent/buyer-tools.ts:1069 + task-store.ts:675-708 |
| 3-26 | memory retrieve 每轮全量加载 active/needs_review 行到 JS 打分（SQL 无 LIMIT，MAX_LIMIT=32 只裁输出不裁扫描）：记忆量增长后每轮 O(n)。建议 SQL 侧预过滤 | src/agent/memory/store.ts:955-960 |
| 3-27 | 四处 monkey-patch 上游私有实现（appendMessage、_persist、_rewriteFile、streamSimple）：`as unknown as SessionManagerInternals` 是模块类型逃逸集中点，pi-coding-agent 升级会让 0600 与 no-thinking 两条安全不变量**静默失效**。建议 patch 前加 shape 探测断言 | src/agent/session.ts:73-110, 186-192 + kernel.ts:353-359 |
| 3-28 | `this.handoffRuntime!.ledger` 非空断言 ×3（均有前置早退，安全但脆弱）；handoffSummary 对每候选重复 `events.filter`，事件多时 O(n²) | src/agent/kernel.ts:858, 910, 946 |
| 3-29 | 注入 clock 返回不可解析字符串时 `new Date(NaN).toISOString()` 抛 RangeError 使 open 崩溃：仅影响测试注入坏时钟场景。**待确认** | src/agent/kernel.ts:558 |

### 3.4 kiwi — merchant 系列

| # | 发现 | 位置 |
|---|---|---|
| 3-30 | SQLite -wal/-shm 权限未检查（A263 §3-3 未修）：`privateFile` 只校验主库文件，全仓无 -wal/-shm 处理。缓解：session.sqlite/budget.sqlite 均在打开前以 0600 预创建，SQLite 通常让 WAL/SHM 继承主库权限位；作为防御深度建议补 lstat/chmod 校验 | src/merchant/ai-runtime/owner-storage-admission.ts:104-108 |
| 3-31 | `pinned-fetch` body 仅支持 string：Buffer/URLSearchParams 被静默丢弃、发出空 body 请求。建议显式拒绝非 string | src/merchant-gateway/pinned-fetch.ts:231 |
| 3-32 | `http://` 明文出站未被拒：策略校验硬编码 https://（:140）但实际请求按 `url.protocol` 走明文；若上游允许注册 http:// 公网地址，Authorization 头将明文出网。**待确认**上游是否已限定 https | src/merchant-gateway/pinned-fetch.ts:262-271 |
| 3-33 | `queryCommittedDecisionOutcome` 把 rejected 也报 succeeded：对 `decision:"approve"` 的恢复查询会误报成功。建议按 input.decision 区分终态匹配 | src/merchant-core/commands.ts:298-299 |
| 3-34 | `pendingHooks` 泄漏：仅 `outcome.kind !== "not_approvable"` 才删钩子；执行抛错或候选 expired 的闭包（含 sku 上下文）滞留 Map | src/merchant/workbench-service.ts:240, 520 |
| 3-35 | 内存/SQLite settle 契约漂移：内存版对未知租约照改日用量（标注 test-only），SQLite 版抛 unknown_lease，接口语义宜对齐 | src/merchant/ai-runtime/gate.ts:109-118 + sqlite-budget-store.ts:254-256 |
| 3-36 | 数据源路径缺价静默补 0：`price: p.price_minor ?? 0` 把「价格不可得」渲染成 0 元公开报价视图，与 RFQ 侧「价格缺失不降级」原则不一致 | src/merchant/workbench-service.ts:277 |

### 3.5 kiwi — http / trust / privacy

| # | 发现 | 位置 |
|---|---|---|
| 3-37 | `/pricing/previews` 是唯一缺 CSRF guard 的 POST：其余 workbench v1 POST 均调 assertWriteGuards；`readJsonBody` 不校验 content-type，跨站 text/plain JSON POST 可触发（响应无 CORS 不可读，影响限于内部计算） | src/http/merchant-management/api.ts:1100-1105 |
| 3-38 | origin 校验三处实现规则不一致（A263 §2-7，现状部分收敛）：管理 API 头可缺席精确匹配（api.ts:3496）、WebAuthn 一律强制 https（webauthn-confirmation.ts:862-869）、enrollment 绑定字符串全等（enrollment-challenge.ts:139,172）；cloud config 仍只派生单值 publicOrigin。建议抽单一 origin 校验器 | src/http/merchant-management/api.ts、src/auth/webauthn-confirmation.ts、src/cloud/binding/enrollment-challenge.ts |
| 3-39 | WebAuthn origin 一律 https 与 loopback http 部署形态冲突：merchant-oauth.ts:736-740 允许 loopback http issuer，但 WebAuthn 注册在 http 下必然失败 → 本地 http 部署的可信确认功能死路（fail-closed 非安全洞） | src/http/merchant-management/webauthn-confirmation.ts:862-869 |
| 3-40 | MCP handler 层认证是可选契约：`options.auth === undefined` 时 /mcp 完全放行，安全性完全依赖装配层 assertMerchantMcpAuthPolicy。建议 handler 内对非 loopback 请求在无 verifier 时直接 503 | src/mcp/merchant-server.ts:939 |
| 3-41 | 配对码与动态注册共用一个限速池：高频注册可把配对限速条目挤出重置窗口（配对码一次性 + 30 次/小时，影响小）。建议分池 | src/mcp/merchant-server.ts:355-374 |
| 3-42 | JWS 未处理 `crit`/`b64` header 扩展：RFC 7515 要求拒绝不认识的 crit；当前有 EdDSA/ES256 白名单 + 载荷绑定兜底，无已知攻击路径，建议显式拒绝 | src/trust/identity/jws.ts:99-118 |
| 3-43 | 轻度信息泄漏：/health 回显 sessions.size；404 回显请求 path（JSON content-type，无反射风险） | src/http/merchant-server.ts:336 + src/mcp/merchant-server.ts:934-936 |
| 3-44 | workbench-retention `transition()` 读-改-写未包事务：与 assertDeletionComplete 之间理论 TOCTOU，但 COMPLETED 为终态且节点回执条件更新已原子，实际影响可忽略，记录备查 | src/privacy/workbench-retention.ts:302-322 |

### 3.6 kiwi — runtime / CLI / weixin / 组装层

| # | 发现 | 位置 |
|---|---|---|
| 3-45 | `cmdBuyerInit` 成功后打印「✓ 商家配置完成。下一步：kiwi merchant up…」——buyer 形态输出 merchant 文案（copy-paste 串味） | src/cli.ts:1180-1184 |
| 3-46 | SIGTERM 转发后 2.5s 兜底 SIGKILL 会切断子进程优雅结算（negotiation-turn 的 abandonClaim/completeClaim HTTP 调用），claim 仍要等 300s stale TTL 回收；与「正常关停永不升级」注释存在张力 | src/supervisor/wrapper.ts:105-109 |
| 3-47 | `acquireUpLock.stealIfStale` 把 `process.kill(pid,0)` 的 EPERM（进程存在、他人所有）与 ESRCH 同样视为「已死」而接管锁；残留锁 PID 被无关进程复用会永久阻塞 `kiwi up`（fail-closed 可接受但误接管方向不对） | src/supervisor/manage.ts:292-309 |
| 3-48 | 写 `~/.kiwi/credentials.env` 用整体覆盖无读合并：文件里用户手工添加的其它 KEY 在重跑 merchant init 换 token 时静默丢失 | src/product-init.ts:334-340 |
| 3-49 | 数值提取 `/\d+(\.\d+)?/` 不识别百分号：「预算提高 10%」会被解析为把预算收紧到 10（方向+数值双错）。收紧方向 fail-safe 但结果荒谬 | src/operator/strategy.ts:189-215（controller.ts:392-400、runner.ts:127-135 同型） |
| 3-50 | `cmdTui` 的 dataDir 直接用原始 `profile.agent_id` 拼路径，未走 `agentDirName` 消毒（与 :742 resolveServeDataDir 口径不一）：含 `/`、`:` 的 agent_id 在 Windows 直接崩，且与 MCP 写端路径不一致 | src/cli.ts:702 |
| 3-51 | 未知 provider 静默回退 `api="openai-completions"`、`baseUrl=""`：运行时才以晦涩的 fetch 错误暴露；doctor 的 model 检查也因此恒过。建议未知 provider fail-closed | src/runtime/model.ts:86-87 + doctor.ts:104-108 |
| 3-52 | `signedEnrollment === null` 在 :282 已短路返回，其后所有 owner-token 分支为死代码（约 :302-487），且与注释「已废弃参数」矛盾 | src/product-publish.ts:282-292, 302-326, 412-487 |
| 3-53 | weixin 每个长轮询周期（~35s，含零消息轮空）都做一次 tmp+fsync+rename 全量写 sync state：写放大明显，可仅在游标/seen 实际变化时落盘 | src/weixin/channel.ts:237 |
| 3-54 | `runFanoutBuyer` 自建 console.log 打穿 stdout：cmdDemo 契约是「阶段可视化进 stderr、stdout 保持 JSON 可消费」 | src/demo/demo-runner.ts:402-404, 569 |

### 3.7 kiwi-catalog — services / api / db

| # | 发现 | 位置 |
|---|---|---|
| 3-55 | run_migrations 用延迟事务（SAVEPOINT）且链内有先读后写（v7/v11 SELECT → CREATE UNIQUE INDEX）：并发双进程首开会踩 SQLite 事务升级死锁路径。建议迁移前 `BEGIN IMMEDIATE` | kiwi_catalog/db/migrations.py:1448 |
| 3-56 | timeout 提交竞态的残余窗口：runner 先查 cancelled 再 commit，supervisor 可在两步之间置位——timeout 结果已落 ledger 并返回调用方，runaway 仍把 catalog 状态推进提交。写围栏管住了 ledger 管不住 service 连接；建议 docstring 明确「timeout 语义为尽力而为」或改提交许可 | kiwi_catalog/services/agent_verification.py:1650-1654 |
| 3-57 | worker loop 异常路径的 `_persist_finish` 带 `status='running'` 守卫，但异常可能发生在 `_persist_running` 之前 → ledger 行仍是 pending、update 静默 no-op，留下 pending 僵尸行被重启后当任务重跑。建议该路径先无条件 delete_task 或放宽守卫 | kiwi_catalog/services/agent_verification.py:1519-1538 |
| 3-58 | reinstate 在 `_moderation_action` 事务提交后 enqueue verify，enqueue 失败会把已成功的治理动作变成 500：register 对同型失败做了优雅降级（:564-568），此处不对称 | kiwi_catalog/api/handlers/agent_catalog.py:891-905 |
| 3-59 | `db/session.py` `VERSION = "0.5.0"` 与 `__init__.py` 0.5.3 漂移，且被写进 meta 表 package_version——所有 ≥0.5.1 安装的库运营读到错误版本；test_version_consistency.py 只锁 `__init__`。建议 session.py re-export 包版本并把 meta 纳入一致性测试 | kiwi_catalog/db/session.py:34（meta 写入 :117） |
| 3-60 | require_merchant_token 的 legacy HMAC 回退只认 body 里的 owner_token：走 Authorization: Bearer 的 legacy 商户（无 merchant_tokens 行）header 值被丢弃 → 恒 403。**待确认** legacy 约定；若 header 应被支持则补齐 | kiwi_catalog/api/auth.py:246-255 |
| 3-61 | `authorize()` 的 `grant` 参数是死代码（handler 生成 secrets.token_urlsafe(32) 传入，service 内部重算忽略之）；user_code 校验在 handler 与 service 重复两处（口径目前一致但属漂移温床） | kiwi_catalog/services/enrollments.py:155-171 + handlers/accounts.py:641,646 |
| 3-62 | 审计事件记录 `token_prefix = token[:24]`（≈256 bit 中的 120 bit）：core/tokens.py 定位为 display hint 可接受，但 audit_events 读取面应保持最小权限，建议在 SECURITY.md 明示该指纹长度取舍 | kiwi_catalog/services/merchant_tokens.py:183, 245 |
| 3-63 | 同一 env secret（KIWI_CATALOG_OWNER_TOKEN_SECRET）派生三种凭据（owner HMAC、Fernet 密钥、enrollment grant HMAC）：各自有消息域分隔、跨协议伪造不可行，但单 secret 泄露爆炸半径是全部三类。建议拆分独立 env 或至少文档化 | kiwi_catalog/services/accounts.py:99-103 + enrollments.py:56-61 |
| 3-64 | resend_code 对未知邮箱抛 "unknown email"，与 forgot/reset 的防枚举统一文案不一致，构成注册邮箱枚举 oracle | kiwi_catalog/api/handlers/accounts.py:257-259（对照 :299-303, 337-340） |
| 3-65 | fallback_asgi 对扩展的 `__html__` 透传带 nosniff/CSP/no-store：dee8e4f 类 HTML 转义问题在包内已无载体（portal 随 641a418 删除），记录该残留透传点 | kiwi_catalog/api/fallback_asgi.py:250-274 |

### 3.8 kiwi-catalog — discovery / agent_catalog / listings / CLI

| # | 发现 | 位置 |
|---|---|---|
| 3-66 | CLI 审计 actor 无凭据校验：任意非空 --admin-token → actor 记为 "admin"，token 从不校验（本地信任边界的既有约定），审计里的 "admin" 不能作问责依据——建议在审计 detail 标注「CLI 未校验声明」 | kiwi_catalog/cli_agent_catalog_commands.py:142-148 + cli_merchant_commands.py:24-25 |
| 3-67 | 畸形绑定行导致签发面 500：`datetime.fromisoformat(expires_at)` 未捕获 ValueError（对照 request_signature.py:137-142 同场景是 fail-closed 403），应同口径 | kiwi_catalog/a2a/binding_claims.py:178 |
| 3-68 | card_digest 格式校验过弱：只验 `sha256:` 前缀 + 总长 72，不验 64 位 hex。实际有 runtime 签名覆盖该字段 + _enrollment_digest_guard 兜底，风险低但应补 | kiwi_catalog/a2a/card_store.py:192-194 |
| 3-69 | 以 actor 字符串格式即权限：`actor.startswith("runtime:")` 决定是否查容量、`actor != "admin"` 决定 governance hold 是否可绕过。当前调用链 actor 由 handler 控制但契约脆弱，建议改显式 caller_kind 参数 | kiwi_catalog/listings/service.py:129, 241 |
| 3-70 | 顶层依赖零约束：`dependencies = ["cryptography", "jsonschema"]` 无版本边界；uv.lock + Dockerfile `--require-hashes` 有保护，但非锁安装（pip install）不受任何下限保护。建议至少设安全下限 | kiwi_catalog/pyproject.toml:20-22 |
| 3-71 | `scan_publication_leaks` 的私钥词表子串匹配会误杀 "tokenize" 类字段（fail-closed 方向误报，可接受） | kiwi_catalog（publication leak 扫描） |

---

## 4. A263 增量 review 修复复核

| A263 发现 | 现状（本次复核） |
|---|---|
| P1-1 sourcing connector 无版本锁定 | ✅ 已修：`integrations/hosts/workbuddy/kiwi-sourcing/mcp.json` 已 pin `@harrylabsj/kiwi@0.12.3` |
| P1-2 确认页仅私有 extension 可达 | 文档化 fail-soft（f89e922 docs/extensions.md）；部署耦合仍在，属部署纪律非代码 bug。生产 catalog 部署必须挂载 admin extension |
| §2-1 public binding claim 未验签 | ✅ 已修：catalog-client.ts:953-990 经 `/v1/issuer-keys` 钉死信任根 + JWS 验签 + 明文/签名逐字段比对 |
| §2-2 跨进程 read-modify-write 无锁 | ⚠️ 部分修复：connect-service persist 与 challenge responder 已持锁 + store_revision CAS（connect-service.ts:1403-1440）；**但 catalog-pipeline.ts:181 的 saveWorkbuddyEnrollment 被漏掉**（本次 P1-3） |
| §2-3 isPublicHostAllowed IPv4 非规范写法 | ✅ 已修：两处调用点均以 WHATWG URL 规范化 hostname 再过 isIP（merchant-connect.ts:58-60、connect-service.ts:477） |
| §2-4 RFC 8628 access_denied 无映射 | ❌ 未修（本次 3-16 维持） |
| §2-5 SAFE_CODES 注册表漂移 | ❌ 未修（本次 3-17 维持，仍是双清单） |
| §2-6 beforePublish 失败 owner 不可见 | ❌ 修复不完整（本次 3-18 维持） |
| §2-7 Origin 校验三处不一致 | 部分收敛：cloud bootstrap 恒传 allowlist 运行态安全；三套规则并存的漂移温床仍在（本次 3-38） |
| §2-8 原子写无 fsync / tmp 不 unlink | ✅ 已修：src/fs/atomic-write.ts 已含文件+目录 fsync、失败 unlink |
| §2-9 selectReusableEnrollment 弃用未删 | ❌ 未动（本次 3-19 维持） |
| §3-1 双开关进程内绕过 | ❌ 未修（本次 2-24） |
| §3-2 grant-file 双实现漂移 | ✅ 已修：checkFileGrant 已重写为委托 createFileGrantResolver().readStrong，无残留第二实现 |
| §3-3 SQLite -wal/-shm 权限 | ❌ 未修（本次 3-30 维持） |
| §3-4 budget.settle() finally 抛错遮蔽 | ✅ 已修且较完整：completeAccounting（owner-session.ts:757-820）抛 OwnerAccountingFailure 携带冻结 businessOutcome；retryAccounting + sqlite 幂等不会双计；残留缺口是 journal 全失败时只能人工对账（fail-closed 可接受）。附带 620 行 owner-accounting-review.test.ts 回归 |
| §3-5 OwnerCommittedProofAuthority dead code | ✅ 已修：owner-business-host.ts:7,17,29 真实消费，由 bootstrap.ts 接线 |

---

## 5. 版本与文档漂移

- `kiwi/README.md:7` 写「当前 0.11.0」，`package.json` 实为 **0.12.3**。
- `kiwi_catalog/db/session.py:34` `VERSION = "0.5.0"` vs `kiwi_catalog/__init__.py` **0.5.3**，且写入 meta 表 package_version（:117）——所有新装库的运营元数据都是错版本（见 3-59）。
- `kiwi_catalog/pyproject.toml` version = "0.5.3" 与 CHANGELOG 最新条目 0.5.3 一致，无漂移。

---

## 6. 架构总评

### kiwi

分层与不变量意识在同类实现中属高位水平：kernel 单串行链消灭并发写、write-gate 统一审批面 + 原子 claim 执行权、vault AES-256-GCM fail-closed、出站 HTTP 全线 redirect:manual + body 上限 + SSRF 策略、fencing 脱敏成体系；Ledger（hash 链 + 内容寻址）+ 幂等三态 + lease fencing token + 八步恢复全部 fail-closed 导向，协议红线（非绑定、三副作用 flag 恒 false、金额整数化）在 domain 校验层硬编码强制。安全面（OAuth 2.1/PKCE、WebAuthn 三重确认、trust 验签后消费 nonce、privacy 隔离红线）经查**未被打破**，历史审查（BUG-01/02/03/06/10、K-M8/M17/M19、H6）大多有对应修复和回归测试。merchant 系列呈现罕见的高纪律性（能力对象 branded types、先决条件重读 + 内容哈希 + 一次性凭证三重校验）。

系统性弱点集中在三处：①**跨模块异常收尾路径**（claim 释放、事务窗口、锁清理）——正常路径全覆盖、异常路径各模块修法不一，恰是本次多个 P1/P2 的共同成因；②**新旧两层成熟度脱节**——旧的 buyer HTTP 包装（src/http/server.ts）与周围层级的认证纪律严重不匹配，是当前唯一需要立即修的面；③**「多主体」假设缺失**——磋商状态按 negotiation_id 单键共享、授权绑定靠注释而非类型强制，单租户部署没问题，开放多买方接入前需补绑定校验（2-1/2-2/2-3）。

### kiwi-catalog

这是一个把「审查驱动修复」写进代码注释的库：migrations.py 的 SAVEPOINT 原子性、fail-closed 重复数据检测、双栈 77/77 条路由程序化比对完全一致（共享同一批 wrapper，剩余风险只在 payload 合并语义）、SQL 全参数化（动态列名均出自白名单）、fetcher 的 SSRF 面封得干净（解析后逐 IP 校验 + 连接 pin 防 DNS rebinding + 重定向全量重校验 + NAT64/CGNAT/zone 实测拦截 + CRLF 注入 stdlib 拒绝）、admin token 轮换与限流先于鉴权消耗实现正确。历史 P1/P2 审查遗留大多已修且有测试钉住。

债务集中在两处：①**文档化纪律与实际行为的漂移**（P1-6 的 query token、catalog_query 注释与谓词不符、route payload 合并语义靠 test_fastapi_dualstack 人肉兜底）——「共享片段复用不彻底」这类边角正是 list 端点复现自己注释里写明的历史 bug 类的原因；②**长期运行的状态泄漏**（幂等 processing 行、pending 僵尸任务、无界账号注册行）。

---

## 7. 测试覆盖印象

### kiwi

297 个测试文件、覆盖密度高且贴合审查史：accept 校验、状态围栏、相位机、handoff 生命周期/幂等/e2e/重验、operator-approval、order-record、崩溃窗口（a2a-crash-real-kill）、autopilot 饥饿/冷却、记账失败恢复（620 行新回归）都有专项；断言具体到状态机迁移序列、精确到分的价格、事件 payload、A2A 信令捕获——测试真实有效、不是虚设。缺口与本次发现精确对应：submit 抛错的 claim 释放路径、vault 预算→默认规则→通知的泄漏链、scope=offer 的相位边、跨 sender 的 negotiation 隔离、JCS 指数边界向量、catalog-pipeline 无锁写入、access_denied 映射、fanout 私钥子串误报、merchant-subscriptions 的超时/大 body 路径均无测试；src/http/server.ts 只有 http-adapter happy-path，认证缺失/超大 body/rebinding 场景完全无覆盖（修 P1-1 时应同步补齐）。

### kiwi-catalog

80 个测试文件总体质量高于平均：真 SQLite + 真迁移、fail-closed 断言、每个修复带回归注释，mock 使用克制（35/80 文件），无「只断言不抛错」注水模式；实跑 913 passed + 72 subtests。缺口与本次发现一一对应：跨 kind 去重、崩溃残留 processing 行、register 的 IP 维度限流均无测试；**agent list 端点翻页没有任何端到端测试——P1-5 因此漏网**；fetcher 的重定向再校验与连接 pin IP 无端到端测试（test_fetcher_limits.py 只覆盖 IP 黑名单单元）。

---

## 8. 建议修复顺序

1. **kiwi `src/http/server.ts`**：加认证 + Host allowlist + 修 body 限制（P1-1），同步补认证/超大 body/rebinding 测试。
2. **buyer-core 授权层**：`limitViolation` 补 limits 执行 + approval 绑定与一次性消费（P1-2）。
3. **catalog-pipeline.ts** 写入方并入 `withEnrollmentStoreLock` + CAS（P1-3）。
4. **kiwi-catalog list 翻页**：谓词换 `agent_cursor_predicate` + v2 游标类型校验（P1-5 + 2-33），补翻页端到端测试。
5. **`npm audit fix`**（P1-7，五分钟）+ 回归 MCP 工具面。
6. **merchant-handler 多主体绑定三件套**（2-1/2-2/2-3）+ JCS 对齐 RFC 8785 向量（2-4）——涉及协议互操作，建议带 conformance transcript 回归。
7. **kiwi-catalog 凭据进 URL 收口**（P1-6 + 3-61 关联项）。
8. P2 其余按模块分批；P3 与 A263 残留（access_denied 映射、SAFE_CODES 单一来源、selectReusableEnrollment、-wal/-shm、switches 能力化）一并清扫；两处版本漂移顺手修。

---

## 9. 审查方法与未验证事项

**方法**：8 个并行只读审查按模块划分（agent；merchant 系列；a2a/protocol/contracts/handoff；cloud/fanout/discovery/net；negotiation/counterparty/buyer-core/commerce；http/trust/auth/privacy/mcp/config；runtime/supervisor/operator/weixin/入口与组装层；kiwi-catalog 两路），全部断言要求基于实读代码（file:line）；汇总者对全部 7 个 P1 中的 5 个代码项实读交叉抽验（P1-1/2/3/5/6 确认属实），并复跑 npm audit、版本一致性检查、游标谓词静态比对。

**未验证事项**：
- kiwi 未跑全量测试套件（288 个测试文件）——本次为只读审查，未执行 vitest run / tsc typecheck 全量。
- kiwi-catalog 未做全量依赖漏洞扫描（本机无 pip-audit）；uv.lock 关键包版本为人工抽查。
- 少数条目标注「待确认」（3-20/3-22/3-29/2-29/3-32/3-60），依赖外部系统行为（iLink 判重语义、部署上游约束、legacy 商户约定）或低概率注入场景，需结合部署形态判断。
- 各 P3 条目的性能影响估算基于代码走读，未做基准测试。

</details>

## 本批33项修复前问题与验收要求（历史归档，已闭环）

<details>
<summary>展开修复前描述；不是当前待修bug</summary>

## 待完成 bug（33项）

| ID | 原裁定 | 当前收窄描述 | 最低验收标准 / 下一步 | 当前源码定位 |
|---|---|---|---|---|
| 2-1 | 成立 | 商家handler按negotiation_id共用相位/报价状态，未将入站ctx.senderIdentity及actor与该谈判/active offer当事人绑定；另一已认证sender知晓ID时可进入accept/withdraw等商业状态路径。 身份通过认证不等于拥有这场谈判；不把它写成匿名认证绕过。应按offer作者/对手方核身份，保合法同owner与重启恢复。 | 跨sender/伪actor accept、withdraw在改状态/产agreement前拒绝；正确当事人合法接受及作者撤回正常。；首次绑定来自可信transport身份；恢复后同绑定有效，不能只信wire actor，也不能放宽既有phase guard。 | [kiwi/src/a2a/server/merchant-handler.ts:338](/Users/jianghaidong/coding/kiwi/src/a2a/server/merchant-handler.ts:338)<br>[kiwi/src/a2a/server/merchant-handler.ts:746](/Users/jianghaidong/coding/kiwi/src/a2a/server/merchant-handler.ts:746) |
| 2-7 | 成立 | MCP buyer回复提取仍把knp_envelope直接cast，未统一校验raw digest/schema/actor/请求关联；此独立buyer路径仍未使用KNP Channel的Ledger/lease/恢复幂等，重试构造新message_id。 不能再泛称完全无持久化或金额完全不设防：48已加结构化报价事实、limits与本地消费事务；那不是KNP wire验证或协议Ledger。 | 真实reply先按raw验证digest/top-level/schema/actor及negotiation/in_reply_to，再供业务使用；非法回复不得成功候选/接受。；重试使用既有稳定消息/效果绑定并有协议事实恢复，结果未知不得TTL清claim重驱；保48金额/限额正负路径。 | [kiwi/src/buyer-core/a2a-knp.ts:122](/Users/jianghaidong/coding/kiwi/src/buyer-core/a2a-knp.ts:122)<br>[kiwi/src/buyer-core/a2a-negotiator.ts:198](/Users/jianghaidong/coding/kiwi/src/buyer-core/a2a-negotiator.ts:198) |
| 2-10 | 部分成立/需收窄 | 同一SQLite连接的runInTransactionAsync在BEGIN/COMMIT之间await回调；release实际prepareCandidate也await。同连接另一调用可插入该事务并随其rollback，不能由“仅微任务”注释证明隔离。未证明当前回调已经发外部网络。 | 合成同连接异步屏障：无关写不被release rollback连带撤销、无关读取不误认未提交release；原候选/release同单元提交或回滚仍保持。不得持事务跨真实外部await。 | [kiwi/src/merchant-core/rfq/repository.ts:233](/Users/jianghaidong/coding/kiwi/src/merchant-core/rfq/repository.ts:233)<br>[kiwi/src/merchant-core/rfq/release-coordinator.ts:154](/Users/jianghaidong/coding/kiwi/src/merchant-core/rfq/release-coordinator.ts:154) |
| 2-16 | 成立 | 登录失败累计count在五分钟block到期后不重置，新一次错误会立即再次block。并非永久无法登录：到期后正确密码仍可清零；持续错误可反复延长封锁。socket IP在反代部署会共享桶。 | 锁到期后新失败窗口从1计，不因旧累计立即续锁；正确密码到期可登录。代理源只从明确受信配置取，禁止直接信任伪造XFF。 | [kiwi/src/mcp/merchant-server.ts:363](/Users/jianghaidong/coding/kiwi/src/mcp/merchant-server.ts:363)<br>[kiwi/src/mcp/merchant-server.ts:620](/Users/jianghaidong/coding/kiwi/src/mcp/merchant-server.ts:620) |
| 2-19 | 成立 | MerchantSubscriptionStore默认fetch请求没有Abort总期限、response.text无响应字节上限；snapshot分页只验next_offset为number，不验有限整数/前进、总页数/总记录，active数组可持续累积。 只成立于该feed客户端，不作“全仓唯一”断言；注入受限fetch可缓解请求但不自动约束分页。 | 请求和body共享有界可取消期限与字节cap；挂起/滴流/超大体明确失败并收尾。；next_offset需有效前进且总页/项有界；重复/NaN/无限页拒绝，正常分页与事务更新保持。 | [kiwi/src/discovery/merchant-subscriptions.ts:64](/Users/jianghaidong/coding/kiwi/src/discovery/merchant-subscriptions.ts:64)<br>[kiwi/src/discovery/merchant-subscriptions.ts:219](/Users/jianghaidong/coding/kiwi/src/discovery/merchant-subscriptions.ts:219) |
| 2-20 | 成立 | disclosure兜底按serialized JSON的字符串前缀匹配私有字段，sku值phone-case/contact-lens等也命中，合法RFQ被拒。 是fail-closed误报/可用性，不是私钥泄漏；不能为放行SKU删除真正private字段保护。 | 按对象键/结构位置判定private属性；合法phone/contact前缀值通过。；真实private字段无论嵌套位置仍拒；各disclosure tier已有门控不削弱。 | [kiwi/src/fanout/disclosure.ts:182](/Users/jianghaidong/coding/kiwi/src/fanout/disclosure.ts:182)<br>[kiwi/src/fanout/disclosure.ts:123](/Users/jianghaidong/coding/kiwi/src/fanout/disclosure.ts:123) |
| 2-27 | 成立 | merchant up的runMerchantSetupPublic错误仍向顶层抛并最终TRANSIENT；setup-public同SetupPublicError返回CONFIG。2-26新增Caddy清理只覆盖后面的node启动，没有统一该退出分类。 | 同一SetupPublicError在两CLI入口输出一致且按配置错误退出；保真正运行时网络错误分类及已完成Caddy收尾。 | [kiwi/src/cli.ts:2214](/Users/jianghaidong/coding/kiwi/src/cli.ts:2214)<br>[kiwi/src/cli.ts:2176](/Users/jianghaidong/coding/kiwi/src/cli.ts:2176) |
| 2-28 | 成立 | cmdWeixin open/login外层catch统一CONFIG，包含启动阶段网络/会话类异常；runLoop自身已有细分类，因此不能泛称所有微信运行错误都错误退出。 | 合成open/login错误按WeixinError类别映射配置与瞬时退出；正常run已有处理保持；无需真实微信调用。 | [kiwi/src/weixin/cli-weixin.ts:112](/Users/jianghaidong/coding/kiwi/src/weixin/cli-weixin.ts:112)<br>[kiwi/src/weixin/cli-weixin.ts:130](/Users/jianghaidong/coding/kiwi/src/weixin/cli-weixin.ts:130) |
| 3-7 | 成立 | createTask查后insert在两个连接同键竞争时可能裸UNIQUE错误；单连接同步段不交错。updateTask整体payload更新无CAS，跨连接或调用方持旧patch可覆盖新字段，不能泛称任意单连接调用必丢更新。 | 双连接同幂等键竞争两调用应解析到同任务；陈旧payload更新应显式冲突或保新字段。保accept现有短事务与历史同ID重放，不自动真实schema迁移。 | [kiwi/src/buyer-core/store.ts:156](/Users/jianghaidong/coding/kiwi/src/buyer-core/store.ts:156)<br>[kiwi/src/buyer-core/store.ts:224](/Users/jianghaidong/coding/kiwi/src/buyer-core/store.ts:224) |
| 3-8 | 成立 | required()记录reconciliation error时总传profile=null，已解析对手方后失败的路径仍记counterparty_identity=unresolved，审计上下文丢失。 是恢复API审计准确性；profile确未解析的失败仍应unresolved，不将未知身份伪造为可信。 | 已resolved后getState/replay等失败的reconciliation事件保真实profile.identity。；resolve本身失败正控仍unresolved，原reason/code与unknown阻断不变。 | [kiwi/src/negotiation/recovery/recover.ts:248](/Users/jianghaidong/coding/kiwi/src/negotiation/recovery/recover.ts:248)<br>[kiwi/src/negotiation/recovery/recover.ts:236](/Users/jianghaidong/coding/kiwi/src/negotiation/recovery/recover.ts:236) |
| 3-13 | 成立 | 默认A2AClient与UcpCheckoutClient先DNS安全复查、随后native fetch独立解析，未把被验证IP固定到实际连接，仍有rebind窗口。 注入pinned transport可缓解；48修的是Python discovery fetcher，不能视为这些TS默认client已pin。 | 预查通过IP用于真实连接；后续DNS切私网不改变目标，或在连接前拒。；保TLS logical hostname/SNI/证书验证、redirect manual与原认证/timeout，不以信任任意IP替代TLS。 | [kiwi/src/a2a/client/client.ts:103](/Users/jianghaidong/coding/kiwi/src/a2a/client/client.ts:103)<br>[kiwi/src/a2a/client/client.ts:144](/Users/jianghaidong/coding/kiwi/src/a2a/client/client.ts:144) |
| 3-14 | 部分成立/需收窄 | InboundPipeline模块级锁表/last sweep跨实例共享，sweep节流用Date.now而不是注入now；不同存储实例可互相节流或无谓串行。 低影响时钟/隔离正确性，不是认证洞或unknown可自动删除依据；同物理store同key原有串行保护不能丢。 | 按实际存储域隔离sweep时钟与节流，并遵守注入时间；两个不同store都能按各自预算触发清理。；同store同key仍串行，不能简单把所有锁移为实例私有导致同文件多实例双执行。 | [kiwi/src/a2a/server/pipeline.ts:159](/Users/jianghaidong/coding/kiwi/src/a2a/server/pipeline.ts:159)<br>[kiwi/src/a2a/server/pipeline.ts:367](/Users/jianghaidong/coding/kiwi/src/a2a/server/pipeline.ts:367) |
| 3-16 | 成立 | 设备轮询仅处理pending/slow_down/authorized；Catalog access_denied没有owner可区分映射，preparing阶段落通用CONNECT_STEP_FAILED。 仅错误语义/诊断缺口，不新增OAuth nonce/远程认证体系；HTTP4xx与成功body拒绝均需保持安全拒绝。 | 商家明确拒绝配对得到稳定且安全owner码，与等待/过期/通信故障不同。；pending、slow_down、authorized合法路径不改变，不把拒绝当可继续绑定。 | [kiwi/src/cloud/catalog-client.ts:492](/Users/jianghaidong/coding/kiwi/src/cloud/catalog-client.ts:492)<br>[kiwi/src/cloud/connect-service.ts:795](/Users/jianghaidong/coding/kiwi/src/cloud/connect-service.ts:795) |
| 3-17 | 部分成立/需收窄 | PUBLICATION_CHECK_FAILED实际产出却不在CONNECTION_PAIRING_SAFE_CODES；workbench集合spread该集合后仍缺此码，摘要被泛化，丢已知安全诊断。 并非两份完全人工pairing清单：API已spread单源；只补遗漏码/映射，不透出任意raw错误或敏感detail。 | 三条产出路径到owner API保持允许的PUBLICATION_CHECK_FAILED或等价稳定safe码。；未知码仍泛化；共享pairing集合保持单源，API专用其它状态码不冒完全重复。 | [kiwi/src/cloud/connect-service.ts:110](/Users/jianghaidong/coding/kiwi/src/cloud/connect-service.ts:110)<br>[kiwi/src/cloud/connect-service.ts:552](/Users/jianghaidong/coding/kiwi/src/cloud/connect-service.ts:552) |
| 3-18 | 成立 | bootstrap beforePublish的产品表绑定错误可传播到connect-service；stepFailureCode不识别ProductTableError且availability.detail置空，owner只知CONNECT_STEP_FAILED。 限诊断可用性。beforePublish可能已做本地效果，补诊断不能顺便清unknown claim/宣称无效果安全重试，也不泄露原产品表内容。 | 已知产品表绑定/归属错误映射安全typed owner说明，readiness故障仍区分。；未知异常保真实unknown/通用错误；claim阶段安全规则和隐私detail白名单不削弱。 | [kiwi/src/cloud/bootstrap.ts:590](/Users/jianghaidong/coding/kiwi/src/cloud/bootstrap.ts:590)<br>[kiwi/src/cloud/connect-service.ts:1079](/Users/jianghaidong/coding/kiwi/src/cloud/connect-service.ts:1079) |
| 3-21 | 成立 | runtime challenge只检查expires_at是string，Date.parse NaN绕过过期比较，可给畸形时间挑战签proof；verifyBindingChallengeProof同型缺有限时间校验。 issued_at有效性/时序需一起明确；内存消费重启可再签只是签发层边界，不等于Catalog会重复接受。不得升级为已证跨端重放漏洞或新增nonce协议。 | 畸形/NaN/过期时间在签名/验proof前拒；合法issued/expires先后与时钟容差按现合同。；同进程重复challenge保持拒；跨重启签发存储选择单独设计，Catalog权威消费保护不能被本地TTL替代。 | [kiwi/src/cloud/binding/runtime-challenge.ts:93](/Users/jianghaidong/coding/kiwi/src/cloud/binding/runtime-challenge.ts:93)<br>[kiwi/src/cloud/binding/runtime-challenge.ts:194](/Users/jianghaidong/coding/kiwi/src/cloud/binding/runtime-challenge.ts:194) |
| 3-22 | 部分成立/需收窄 | fanout腿deadline只在循环开始检查，await handle.getState自身无剩余预算/取消参数；一个底层请求可超总腿期限。 A2A默认client有每请求timeout，不可泛称现有路径全部永久挂；不保证ChannelHandle每实现都有timeout。Promise.race上层返回不等于取消底层。 | 总腿剩余预算传到底层getState实际fetch/读取消，慢请求不能再吃一份完整默认timeout。；兼容原合法getState调用，实际收尾有界；若仅上层deadline须如实描述，不能冒底层终止。 | [kiwi/src/fanout/orchestrator.ts:427](/Users/jianghaidong/coding/kiwi/src/fanout/orchestrator.ts:427)<br>[kiwi/src/counterparty/channel.ts:151](/Users/jianghaidong/coding/kiwi/src/counterparty/channel.ts:151) |
| 3-23 | 部分成立/需收窄 | update/rule/shortlist忽略工具调用_id并生成新uuid幂等键；同逻辑重试可能重复事件/规则。rule store甚至不消费输入幂等键。cancel完成后通常被终态门拒，不能声称取消每次重复成功。 | 同一逻辑工具调用重试的约束更新/规则/shortlist结果与事件唯一，新用户动作仍能产生新操作；取消终态拒绝保持。 | [kiwi/src/agent/buyer/buyer-tools.ts:1003](/Users/jianghaidong/coding/kiwi/src/agent/buyer/buyer-tools.ts:1003)<br>[kiwi/src/agent/buyer/buyer-tools.ts:1075](/Users/jianghaidong/coding/kiwi/src/agent/buyer/buyer-tools.ts:1075) |
| 3-24 | 成立 | redactPrivateFloor把String(floor)直接插正则，只覆盖一种十进制文本且小数点未转义；80.5与80.50等同值表示可漏掩码，亦可过度匹配。只确认该公开输出纵深helper，不沿旧镜像路径推断更多调用。 | 完整数字token的等值十进制表示均脱敏，非等值/子串不误伤；不记录或回显真实底价，仅合成数值正负控。 | [kiwi/src/agent/negotiation-chat.ts:101](/Users/jianghaidong/coding/kiwi/src/agent/negotiation-chat.ts:101) |
| 3-31 | 成立 | createPinnedFetch声明typeof fetch但只传init.body，实际write只接受string；Buffer/URLSearchParams或Request自带body可静默变空。 通用adapter合同缺陷，现主要注册/tool生产caller用JSON string，未证明当前业务因此丢body；不处理流式上传可以显式拒绝，不能静默丢。 | 支持的body字节原样发；不支持类型在发请求前明确拒绝，Request body有明确处理/拒绝。；保现JSON string、IP pin、TLS SNI和响应cap；不为兼容body放宽目标策略。 | [kiwi/src/merchant-gateway/pinned-fetch.ts:231](/Users/jianghaidong/coding/kiwi/src/merchant-gateway/pinned-fetch.ts:231)<br>[kiwi/src/merchant-gateway/pinned-fetch.ts:257](/Users/jianghaidong/coding/kiwi/src/merchant-gateway/pinned-fetch.ts:257) |
| 3-33 | 成立 | queryCommittedDecisionOutcome对executed或rejected都无条件succeeded，未按input.decision区分；approve查询遇rejected会误报所批准动作已成功。 | approve与reject各只匹配自己的权威终态；不匹配返回失败/unknown且不重新执行，保持合法同操作恢复。 | [kiwi/src/merchant-core/commands.ts:284](/Users/jianghaidong/coding/kiwi/src/merchant-core/commands.ts:284) |
| 3-34 | 部分成立/需收窄 | 有pendingHooks的候选过期后markApproved会抛expired，workbench catch不删闭包；确定终态可残留钩子。执行异常可能是未知效果，不能一律删除未知钩子假恢复。 | expired/rejected等确定不再执行的钩子可释放且重复approve不执行业务；unknown留对账信息，不以finally全删兜底。 | [kiwi/src/merchant/workbench-service.ts:240](/Users/jianghaidong/coding/kiwi/src/merchant/workbench-service.ts:240)<br>[kiwi/src/merchant/workbench-service.ts:517](/Users/jianghaidong/coding/kiwi/src/merchant/workbench-service.ts:517) |
| 3-36 | 成立 | listPublicProducts的dataSource缺price_minor时补0，公开商品视图混淆未知价与免费；并不证明RFQ或订单接受了0价。 | 缺价显示明确未知或不可报价，真实0价仍可表示；RFQ已有缺事实拒绝保持。 | [kiwi/src/merchant/workbench-service.ts:270](/Users/jianghaidong/coding/kiwi/src/merchant/workbench-service.ts:270) |
| 3-42 | 成立 | verifyCompactJws对protected header仅取alg/kid，不处理crit及不支持的b64语义；有效签名但未知critical扩展不能被正确拒绝，属标准互操作/防御缺口。 签名仍覆盖完整protected header，不是未签字段篡改绕过；普通未标crit未知header应忽略。沿既有受限profile，不新增密码算法/nonce/远程认证。 | 真实合法签名带未知/不支持crit拒；不支持b64:false明确拒，不按base64url载荷误解。；正常EdDSA/ES256正控及普通noncritical未知header保持互操作；保持payload绑定和alg白名单。 | [kiwi/src/trust/identity/jws.ts:99](/Users/jianghaidong/coding/kiwi/src/trust/identity/jws.ts:99)<br>[kiwi/src/trust/identity/jws.ts:111](/Users/jianghaidong/coding/kiwi/src/trust/identity/jws.ts:111) |
| 3-44 | 部分成立/需收窄 | retention transition按旧status校验后UPDATE只按request_id写；跨连接陈旧合法转换可覆盖另一连接已COMPLETED终态。未证删除数据复活或节点删除回执被撤销。 | 双连接完成与旧状态转换竞争时终态不回退，失败方显式冲突；真实删除回执与正常转换语义保持，不新增真实迁移。 | [kiwi/src/privacy/workbench-retention.ts:301](/Users/jianghaidong/coding/kiwi/src/privacy/workbench-retention.ts:301) |
| 3-47 | 成立 | up锁探测catch除SupervisorError外不区分ESRCH/EPERM/其它异常，且坏PID也删；只有确认dead可接管的语义未落实。PID复用导致保守阻塞不是本bug。 | EPERM/未知PID/异常不unlink；正常已确认ESRCH按安全归属恢复，保活owner和锁并发保护，不盲复制别处锁实现。 | [kiwi/src/supervisor/manage.ts:292](/Users/jianghaidong/coding/kiwi/src/supervisor/manage.ts:292) |
| 3-48 | 成立 | merchant init显式token写credentials.env整文件单行覆盖，原用户其它KEY会丢；本轮未读取任何真实凭据。 | 只用临时假凭据验证保其它KEY、仅更新目标KEY并维持0600/原子写；不自动迁移真实secret。 | [kiwi/src/product-init.ts:334](/Users/jianghaidong/coding/kiwi/src/product-init.ts:334) |
| 3-49 | 成立 | 预算指令先抓首数值，“预算提高10%”在基准>10时被当绝对10并判tighten；runner hints同型。属于方向/金额语义错误，不是HardPolicy越权自动提高预算。 | 百分比需明确基准与方向/舍入或拒含糊输入；绝对金额与合法放宽确认保持，不能扩大HardPolicy。 | [kiwi/src/operator/strategy.ts:107](/Users/jianghaidong/coding/kiwi/src/operator/strategy.ts:107)<br>[kiwi/src/operator/strategy.ts:189](/Users/jianghaidong/coding/kiwi/src/operator/strategy.ts:189) |
| 3-50 | 成立 | cmdTui缺省目录仍直接拼profile.agent_id，与serve归一口径不同；含分隔符/冒号的可信配置可分裂本地状态或平台不兼容。未证远程任意路径攻击。 | 两入口同身份共享稳定目录解析并保显式dataDir；legacy目录恢复需可见且不得自动迁移/覆盖用户存储。 | [kiwi/src/cli.ts:703](/Users/jianghaidong/coding/kiwi/src/cli.ts:703) |
| 3-51 | 部分成立/需收窄 | 未知provider且未显式api/base_url时fallback openai-completions/空URL，buildModel不拒、doctor解析项会报告成功；完整自定义provider配置本来可合法工作。 | 不完整未知配置给清晰配置错误，doctor不误报该解析项；完整custom api/baseURL与已知provider不一刀切禁用。 | [kiwi/src/runtime/model.ts:84](/Users/jianghaidong/coding/kiwi/src/runtime/model.ts:84)<br>[kiwi/src/doctor.ts:104](/Users/jianghaidong/coding/kiwi/src/doctor.ts:104) |
| 3-54 | 成立 | cmdDemo声明阶段输出stderr/stdout JSON，但runFanoutBuyer自建console.log写stdout，runDemo实际调用该函数；运行时阶段行可污染JSON消费。 | 合成demo完整stdout一次JSON解析成功，阶段日志在stderr；库调用可注入logger，不为验收启动真实业务服务。 | [kiwi/src/demo/demo-runner.ts:402](/Users/jianghaidong/coding/kiwi/src/demo/demo-runner.ts:402)<br>[kiwi/src/cli.ts:2089](/Users/jianghaidong/coding/kiwi/src/cli.ts:2089) |
| 3-56 | 成立 | runner在cancelled.is_set()返回False后才调用service.commit；supervisor可在两者之间设置cancelled并持久化timeout/返回。service连接仍可能随后提交catalog状态，ledger running守卫只约束结果行。close(commit=not cancelled.is_set())也不是原子提交许可。 VerificationQueue真实service连接提交和timeout结果一致性；不是声称每次timeout都会推进状态。 A343同agent/preclaim/正常shutdown修复未改该执行提交窗口；A346抓取截止亦不能原子化service事务。 timeout不是已知未执行，不得据此自动清unknown或安全重驱；当前_load_profiles另有已声明快照/索引短事务提交，不将其当此次晚提交竞态。 | 合成真实service事务+双屏障：timeout先取得裁决时，service.commit为零且close不隐式提交，catalog三域/审计业务变更未落（保已声明独立快照/索引缓存语义）。；提交许可先取得裁决时，supervisor不能同时声称明确未执行的timeout；结果/ledger与已提交效果一致，提交或确认仍未知时保未知语义。；保同agent不同kind串行与正常shutdown，不用删除processing/unknown来获得重试；若只保尽力语义，先明确返回/文档和caller不能将timeout视未执行，不能保留“timeout不推进catalog”的绝对注释。 | [kiwi-catalog/kiwi_catalog/services/agent_verification.py:1664](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/services/agent_verification.py:1664)<br>[kiwi-catalog/kiwi_catalog/services/agent_verification.py:1753](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/services/agent_verification.py:1753) |
| 3-71 | 成立 | scan_publication_leaks递归dict/list，对lowercased key做any(pattern in key)。词表含token，因此无秘密含义的tokenize等扩展key也会产生泄漏路径，validate_publication据此拒整个发布。key子串规则不扫描任意普通文本值；值/真正秘密另由scan_secrets处理。 A2A publication对象的字段名递归子串匹配；不是所有包含tokenize的值都会被这条规则命中。 48补card_digest hex格式没有改变该词表/遍历，当前429f547仍保原误报行为。 fail-closed方向防守但可拒合法schema扩展；若产品决定禁这些词片段，应如实写字段合同而非断言其必然是私密字段。 | 若收窄匹配，合成tokenize等允许扩展key/普通值应不误拒，同时owner_token/api_key/private/floor等真正禁止字段与真实secret值仍拒，不能整体关scan。；覆盖嵌套dict/list并保持准确JSON路径、整次发布回滚和旧活动名片保留。；若维持保守词表，明确允许字段限制/已知误报和使用方绕行约定，不叫信息泄漏漏洞已证或自动修所有发布内容。 | [kiwi-catalog/kiwi_catalog/a2a/card_store.py:58](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/a2a/card_store.py:58)<br>[kiwi-catalog/kiwi_catalog/a2a/card_store.py:119](/Users/jianghaidong/coding/kiwi-catalog/kiwi_catalog/a2a/card_store.py:119) |


</details>
