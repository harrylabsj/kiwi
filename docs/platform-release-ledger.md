# Kiwi 平台发布版本台账

最近一次发布与生产部署核验为 2026-11-26（北京时间），各平台状态以对应条目的核验日期为准。本表记录**已观察到的版本与当时状态**，不是实时查询；候选代码、注册表版本、平台审核和实际云端运行分开记录。部署、上线或发布新版本后，应补充平台链接、版本、状态、核验时间与回执；不得以代码提交或审核提交代替上线证据。

## npm 与 PyPI

| 平台 | 产品 | 已确认版本 | 证据与限制 |
|---|---|---:|---|
| npm | `@harrylabsj/kiwi` | 0.12.40 | 2026-11-26 portfolio run [45815046350](https://github.com/harrylabsj/kiwi/actions/runs/45815046350) 发布；下载 tarball 复算 SHA-1（`ff60b617…`）与发布日志、registry 元数据三方一致，干净安装通过。[npm 版本页](https://www.npmjs.com/package/@harrylabsj/kiwi/v/0.12.40)。 |
| npm | `@harrylabsj/kiwi-merchant-cloud` | 0.12.40 | 2026-11-26 同一 portfolio run 发布；下载 tarball 复算 SHA-1（`a45abf8e…`）与发布日志、registry 元数据一致。[npm 版本页](https://www.npmjs.com/package/@harrylabsj/kiwi-merchant-cloud/v/0.12.40)。 |
| npm | `@harrylabsj/kiwi-dsh-plugin` | 0.1.4 | 2026-11-11 portfolio run 发布并回读核验；npm 可查 0.1.4。[npm 版本页](https://www.npmjs.com/package/@harrylabsj/kiwi-dsh-plugin/v/0.1.4)。 |
| PyPI | `kiwi-catalog` | 0.5.30 | 2026-11-25 portfolio run [45617840510](https://github.com/harrylabsj/kiwi/actions/runs/45617840510) 发布，手工回读 PyPI latest=0.5.30 并干净安装核验；**生产 kiwi-hk 已于同日部署 0.5.30 + admin 0.2.28（whl sha256 与 PyPI 逐字节一致），schema user_version=60 无变更**。[PyPI 版本页](https://pypi.org/project/kiwi-catalog/0.5.30/)。 |
| PyPI | `shopping-cli` | 3.2.12 | 2026-11-25 回读 PyPI latest=3.2.12（发布链路见当日晚间其他会话记录，本台账只确认 registry 状态）。[PyPI 版本页](https://pypi.org/project/shopping-cli/3.2.12/)。 |

上表确认指定版本可查，不声称它们必然仍是 registry 当前 latest（2026-11-26 已确认 `@harrylabsj/kiwi` latest=0.12.39、`@harrylabsj/kiwi-merchant-cloud` latest=0.12.39、`kiwi-catalog` latest=0.5.30、`shopping-cli` latest=3.2.12）。`kiwi-catalog-admin` 0.2.18 已推送私有 tag `v0.2.18`，并作为生产 catalog 的扩展安装；它不是公开 registry 制品。

## 2026-11-26 kiwi 0.12.40 发布与生产部署（商品事实应答 + RFQ 回执恢复 + 微信自有模型配置）

- 内容：商家基于已发布商品事实回答买家问题（a6348290）；买家 RFQ 回执丢失恢复、不重发询价（7380280c）；工作台支持配置商家自有微信模型（e8939bde）、显示模型服务端点（5e02a800）、修复授权后凭据字段挂载（82a9a133）。
- 发布源：main `33b94e42`（候选准备 `5249eeef`、验收回执 `ae7b4e24`、冻源刷新 `33b94e42`）；catalog `11c12bd`、shopping-cli 3.2.12 未变、未重发。
- 真实端到端验收：2026-11-26T11:40Z 对生产目录 `https://catalog.kiwi.harrylabsj.com` 与真实商家 Veyquo（`mkt_veyquo_A0UPvj7XuYk` / `VQ-001` / 2 个）跑通 search → quote → negotiation → preaccept → agreement → handoff，非约束 agreement `agreement-01a217a7-fe74-718e-b50b-b0a3feb73826`；不下单、不付款、不锁库存。
- GitHub run：dry-run [45812833415](https://github.com/harrylabsj/kiwi/actions/runs/45812833415) 成功；首次 publish 调度 [45814725408](https://github.com/harrylabsj/kiwi/actions/runs/45814725408) 被 fail-closed 拒绝（publish=true 要求 `ref` 输入为完整 40 位 SHA，误传命名引用 `main`）；以完整 SHA 重新调度，发布 [45815046350](https://github.com/harrylabsj/kiwi/actions/runs/45815046350) 成功，channels=`npm,merchant-cloud`，经 `kiwi-release` 保护环境人工审批。`verify-registry` job 仍 skipped（已知缺陷），以下为发布后手工回读。
- registry 回读（2026-11-26 北京时间，手工）：npm `@harrylabsj/kiwi` latest=0.12.40（下载 tarball SHA-1：`ff60b617f054ca2d6430523bfc7f96f2356ed52f`，与发布日志一致）；`@harrylabsj/kiwi-merchant-cloud` latest=0.12.40（SHA-1：`a45abf8e014e56954105920db1a1af3c483a4076`）。干净安装 `@harrylabsj/kiwi@0.12.40` 通过（`cli.js --version` 输出 0.12.40）。
- 候选验证（kiwi-hk，2026-11-26 19:37 北京时间）：候选 `5249eeef` 部署 runtime+workbench（`releases/kiwi-0.12.40-candidate-5249eeef`），验收通过后停用候选 drop-in。
- 正式部署（kiwi-hk，2026-11-26 20:20–20:30 北京时间）：官方 registry tarball（SHA-1 复核一致）建 `releases/kiwi-0.12.40-20261126-202048` 与 `kiwi-0.12.40-workbench-20261126-202048`；部署前快照 `backups/pre-0.12.40-final-20261126-202048.tgz`；drop-in 由候选改指正式目录（旧 conf `.disabled-20261126-202048` 可回滚）。网关 `/opt/kiwi-gateway/app` 升级到 0.12.40，旧版保留 `app.prev-20261126-202048`。注意：npm tarball 内文件 mtime 统一为 1985-10-26，rsync 同步必须加 `--checksum`/`-I`，否则同尺寸文件被静默跳过（本次网关首次同步即因此未生效，复核版本号时发现并重同步）。验证：kiwi-gateway、kiwi-merchant-v2、kiwi-workbench、kiwi-catalog 均 active；gateway `/health` 与 OAuth metadata 200；Veyquo agent-card 200、`/a2a` 405（预期）、`/merchant/` 200；三服务近 3 分钟 error 日志为空。
- 部署后端到端复验：对生产目录 + Veyquo 重新跑通 search → quote → negotiation → preaccept → agreement → handoff（非约束，新 agreement `agreement-01a217d2-4b64-72be-81cb-ae9be250e400`），未下单/未付款/未锁库存。
- 未做：`verify-registry` needs/`always()` 缺陷未修；WorkBuddy / 商城平台资产未随本次发布更新或审核。

## 2026-11-26 kiwi 0.12.39 发布与生产部署（店主对话区间统计 + 范围诚实声明）

- 动因：0.12.38 线上实测暴露两点——「过去 7 天有没有来咨询的客户」无数据源（被模型套进 today 桶答非所问）；店主确立产品原则「意图理解必须精确，能力达不到要明确告知」。
- 内容：#239 店主对话区间/今日统计（`OwnerInquirySource.rangeStats(since)` 计数数据源，A2A 账本按链路计：区间内最后买家入站落进范围数 + 其中待回复数；模型仍只做意图分类，计数本机渲染、不进模型上下文；「今天」按对话时区本地零点；days 1-30 必须店主明确给出）；#242 范围诚实声明（模型 SYSTEM 禁止套用不相干动作顶替，规则兜底回复先明示「超出能核实的范围、未执行查询」再列能力）。
- 发布源：main `e5c492cb`（#239、#242、#241 候选、#243 合同刷新、#244 验收回执）；catalog `11c12bd`、shopping-cli 3.2.12 未变、未重发。
- GitHub run：dry-run [45753388729](https://github.com/harrylabsj/kiwi/actions/runs/45753388729)（候选）、复核 dry-run [45755840702](https://github.com/harrylabsj/kiwi/actions/runs/45755840702)、发布 [45757093506](https://github.com/harrylabsj/kiwi/actions/runs/45757093506)（channels=`npm,merchant-cloud`，经 `kiwi-release` 保护环境人工审批）。
- registry 回读（2026-11-26，手工）：npm kiwi/merchant-cloud latest=0.12.39；下载 tarball 复算 SHA-1 与发布日志、registry 元数据三方一致（kiwi `fe54c260…`、merchant-cloud `08de0e69…`）；dry-run 候选与正式制品逐字节相同。`verify-registry` job 仍 skipped（已知缺陷未修）。
- 候选验证（kiwi-hk，2026-11-26 12:22 北京时间）：候选 `f5e426b2`（sha1 `fe54c260…`）部署 runtime+workbench；端到端验收通过（非约束 `agreement-01a2161a-c754-7322-aefe-5b732c17f998`）。部署前快照 `backups/pre-0.12.39-candidate-20261126-122250.tgz`。
- 正式部署（kiwi-hk，2026-11-26 13:06 北京时间）：官方 tarball 建 `releases/kiwi-0.12.39-20261126-130654` 与 `kiwi-0.12.39-workbench-20261126-130654`，drop-in 由 candidate 改指正式目录（旧 conf `.disabled-20261126-130654` 可回滚）；部署前快照 `backups/pre-0.12.39-final-20261126-130654.tgz`。验证：两服务 active、agent-card 200、`/merchant/` 200、重启后日志零错误。微信区间统计实测待店主确认。
- 未做：`verify-registry` needs/`always()` 缺陷未修；冻源前置进 PR CI 未做；模型默认开启产品化未排期；`PROVIDER_BASE_URL[deepseek]` 与门禁端点不一致未修（profile 层 `/v1` 规避在位）。

## 2026-11-26 kiwi 0.12.38 发布与生产部署（微信「只回第一条」修复）

- 动因与根因：Veyquo 微信通道开 Pi 模型对话后实测发现「只有进程重启后的第一条回信能送达」——iLink 客户端 `client_id` 每进程生成一次并复用于所有出站消息，微信服务端按 client_id 幂等判重，第 2..N 条 ret=0 但实际丢弃（`full-codebase-code-review-2026-10-07.md` 2-29 条曾预言此症状；Hermes 参考实现为每消息一个 uuid）。生产证据：0.12.37 上 seq=4 送达、seq=5/6/7 服务端 accepted 但用户未收到；服务端时间线（入库→模型→发送）秒级核对排除模型延迟。
- 修复：#235 `sendMessage` 按调用生成新 client_id（会话层每条逻辑消息只发一次、不落自动重发，不会重复送达），含「同进程两条消息 client_id 必须不同」契约测试。
- 发布源：main `50f37151`（#235 修复、#236 0.12.38 候选、#237 合同刷新——#234 台账后合入触发 SHIPPING_SOURCE_CHANGED fail-closed 后的重冻、#238 验收回执）。
- GitHub run：候选 dry-run [45722759943](https://github.com/harrylabsj/kiwi/actions/runs/45722759943)、最终复核 dry-run [45746141097](https://github.com/harrylabsj/kiwi/actions/runs/45746141097)、发布 [45747373686](https://github.com/harrylabsj/kiwi/actions/runs/45747373686)（channels=`npm,merchant-cloud`，经 `kiwi-release` 保护环境人工审批）。
- registry 回读（2026-11-26，手工）：npm kiwi/merchant-cloud latest=0.12.38；下载 tarball 复算 SHA-1 与发布日志、registry 元数据三方一致（kiwi `f517b7d4…`、merchant-cloud `427f343f…`）；**dry-run 候选制品与正式发布制品逐字节相同**（确定性构建）。`verify-registry` job 仍 skipped（已知缺陷未修，手工回读覆盖）。
- 候选验证（kiwi-hk，2026-11-26 07:48–08:03 北京时间）：候选 `6fa3eafd`（sha1 `f517b7d4…`）部署 runtime+workbench（`releases/kiwi-0.12.38-candidate-6fa3eafd`、`-workbench-candidate-6fa3eafd`）；微信实测 seq=8、9 连续两条均送达且为 Pi 模型回信（修复前同链路 seq=5/6/7 全丢）；端到端验收通过（非约束 `agreement-01a215c3-3bf0-72b6-8b69-baeed3a324d3`，不下单/不付款/不锁库存）。部署前快照 `backups/pre-0.12.38-candidate-20261126-074836.tgz`。
- 正式部署（kiwi-hk，2026-11-26 11:35 北京时间）：官方 tarball 建 `releases/kiwi-0.12.38-20261126-113555` 与 `kiwi-0.12.38-workbench-20261126-113555`（npm install 自 registry 字节），drop-in 由 candidate 改指正式目录（旧 conf 改名 `.disabled-20261126-113555` 可回滚）；部署前快照 `backups/pre-0.12.38-final-20261126-113555.tgz`。验证：两服务 active、`https://veyquo.com/.well-known/agent-card.json` 200、`/merchant/` 200、重启后日志零错误。
- 同日顺带合入（随 0.12.39 发布，未部署）：#239 店主对话区间/今日统计（`rangeStats` 计数数据源，模型仍只做意图分类、数字本机渲染）。
- 未做：`verify-registry` job needs/`always()` 缺陷未修；冻源校验前置进 PR CI 未做；微信模型对话「默认开启」产品化未排期；`PROVIDER_BASE_URL[deepseek]` 缺 `/v1` 与微信 agent 门禁端点不一致未修（Veyquo 已在 profile 层用 `/v1` 规避）；WorkBuddy/商城平台资产未随本次更新。

## 2026-11-26 kiwi 0.12.37 发布与生产部署（Veyquo 微信 Pi 模型对话）

- 动因：Veyquo 微信通道开启 Pi 模型对话——0.12.36 只恢复了规则模板回信；#230 的微信模型功能在 0.12.36 发布后才合入 main，故发 0.12.37。
- 发布源：kiwi `1b07899d`（含 #230 微信模型对话与授权门槛、#231 冻源刷新、#232 台账、#233 0.12.37 候选）；catalog `11c12bd`、shopping-cli 3.2.12 未变、未重发。
- GitHub run：dry-run [45629629627](https://github.com/harrylabsj/kiwi/actions/runs/45629629627) 成功；发布 [45641461858](https://github.com/harrylabsj/kiwi/actions/runs/45641461858) 成功（channels=`npm,merchant-cloud`，经 `kiwi-release` 保护环境人工审批；审批隔日完成，run 排队等待约 7 小时后放行）。
- registry 回读（2026-11-26，手工）：npm kiwi/merchant-cloud latest=0.12.37；下载 tarball 复算 SHA-1 与发布日志逐项一致（kiwi `c0189d0c…`、merchant-cloud `a48d2af9…`），发布含 sigstore provenance。`verify-registry` job 仍 skipped（已知缺陷未修，手工回读覆盖）。
- 生产部署（kiwi-hk，2026-11-26 06:13–06:15 北京时间）：
  - 部署前快照 `backups/pre-0.12.37-20261126-061319.tgz`（data+config）。
  - Veyquo runtime 与 workbench 均从**官方已发布 tarball**（SHA-1 已核验）新建目录安装：runtime `releases/kiwi-0.12.37-20261126-061319`（替代 candidate-63c2ef0b，线上=已发布制品）、workbench `releases/kiwi-0.12.37-workbench-20261126-061319`；两 drop-in 切换，旧 conf 改名 `.disabled-20261126-061319` 保留回滚路径。
  - 验证：两服务 active、`https://veyquo.com/.well-known/agent-card.json` 200、`/merchant/` 200、重启后日志零错误。
- 微信模型对话启用链（同日上午）：
  - workbench env `KIWI_WEIXIN_OWNER_AGENT=1`（`KIWI_WEIXIN_OWNER_REPLIES=1` 保持），进程环境确认含 `DEEPSEEK_API_KEY`。
  - 修复一个隐藏配置雷：profile `model.base_url` 为 `https://api.deepseek.com`（缺 `/v1`），微信 agent 门禁（`weixin-owner-agent-profile.ts`，端点精确比对）判 `unavailable`——修为官方地址 `https://api.deepseek.com/v1`（备份 `config/profile.yaml.bak-20261126-061319`）。附带发现产品层不一致：`PROVIDER_BASE_URL[deepseek]` 默认值同样缺 `/v1`，即不写 base_url 也过不了门禁，记为后续产品修复项。
  - 按 #230 设计，模型配置变化使旧规则模式绑定自动失效（绑定 revision 折入 consent），店主在工作台完成「授权 Kiwi 模型对话」知情同意；服务端只读核对：`owner_binding.revision` 已折入当前 consent（`c67c19f1…`，与按 `["weixin-owner-agent-v1",provider,api,model,endpoint,keyRef]` 独立计算一致）、conversation 轮换、无错误日志。
  - 微信消息实测 Pi 回信（2026-11-26 补记）：seq=4 首条模型回信送达（`owner_agent_turn` 有记录，规则模板时代该表恒空）；seq=5 起暴露 iLink `client_id` 幂等丢消息（见 0.12.38 条目），修复后连续多条均正常送达。
- 未做：`verify-registry` job needs/`always()` 缺陷未修；冻源 PR 前置校验未做；微信模型对话「默认开启」产品化未排期；`PROVIDER_BASE_URL` 与门禁端点不一致未修；WorkBuddy/商城平台资产未随本次更新。

## 2026-11-25 kiwi 0.12.36 / kiwi-catalog 0.5.30 发布与生产部署（海纳百川恢复）

- 动因与全貌：商家海纳百川（catalog agent `cagt_7ASdi11188Fl`）卸载重连「发布名片」连环三层故障，本日发布三个修复后恢复上线：
  1. catalog 0.5.28 绑定版本按 active 数 +1 分配，撞历史 revoked 行 → **409**（修复 `fcc7253`，随 0.5.29 于当日早间发布部署，见上条）；
  2. 实例侧 bind 副作用悬而未决留下僵尸 `operation_claim`，授权窗口过期后 reconcile 标 expired 不清 claim、begin 的未决副作用检查扫全量 sessions → **死锁**（「连接结果尚未确认」循环，清 sessionStorage/无痕无效）；
  3. catalog 生成绑定回执时对 WITHDRAWN（卸载撤回）名片一律拒签 **403**，提交事务整体回滚（修复 `6a10df1`，回执路径允许 allow_withdrawn，随 0.5.30 发布）。
- 发布源：kiwi `8e97e189`（含 #223 实例死锁修复收窄版、#224 M6-3 测试时间炸弹修复、#225 0.12.36 候选、#226/#228 catalog 0.5.30 pin 与冻源、#230 微信回信与模型配置分离、#231 冻源刷新）；catalog `11c12bd`（0.5.30 prepare）；shopping-cli 3.2.12 同日由其他会话发布（pin `4f1a7581`），registry latest=3.2.12。
- 真实端到端验收：2026-11-25 对生产目录 + Veyquo（候选 0.12.36 部署于 kiwi-hk `releases/kiwi-0.12.36-candidate-cb014afa`）跑通 search → quote → negotiation → preaccept → agreement → handoff，非约束 agreement `agreement-01a21021-bcd6-709f-9b0d-85e4d6126be0`；不下单/不付款/不锁库存。
- GitHub run：kiwi 0.12.36 dry-run [45520684887](https://github.com/harrylabsj/kiwi/actions/runs/45520684887)、发布 [45523214785](https://github.com/harrylabsj/kiwi/actions/runs/45523214785)（channels=`npm,merchant-cloud`）；catalog 0.5.30 dry-run [45615788110](https://github.com/harrylabsj/kiwi/actions/runs/45615788110)、发布 [45617840510](https://github.com/harrylabsj/kiwi/actions/runs/45617840510)（channels=`kiwi-catalog`）；均经 `kiwi-release` 保护环境人工审批。期间门禁两次按设计拦截冻源未同步（`SHIPPING_FOREIGN_AUTHORITY_CHANGED` / `SHIPPING_SOURCE_CHANGED`），经 #228/#231 刷新后通过——暴露「合入后刷冻源依赖人工」痛点，待办：把冻源校验前置进 PR CI。
- registry 回读（2026-11-25，手工）：npm kiwi/merchant-cloud latest=0.12.36，下载 tarball SHA-1 与发布日志一致（kiwi `d864b393…`）；PyPI kiwi-catalog latest=0.5.30，干净 venv 安装核验通过。`verify-registry` job 因 needs 含 skipped job 继续 skipped（缺陷未修）。
- 生产部署（kiwi-hk，2026-11-25）：
  - Veyquo runtime：候选验收后转正 `releases/kiwi-0.12.36-20261125-092345`，部署前快照 `backups/pre-0.12.36-candidate-20261125-083531.tgz`；服务 active、零错误日志、agent-card 公网 200。
  - catalog：`/opt/kiwi-catalog-0.5.30-admin-0.2.28`，whl sha256 `b92010ea…` 与 PyPI 逐字节一致；部署前 DB 快照 `/opt/kiwi-catalog-backups/catalog-pre-0.5.30-20261125-210639.sqlite`；schema user_version=60 无变更；新 drop-in（24×9 前缀）生效，0.5.29 drop-in 保留可回滚；本地+公网 /health 200，启动日志干净。
  - 海纳百川 WorkBuddy 实例：发布目录原地升级 0.12.36（upgrade-in-place，config/profile 逐字节保留），WorkBuddy 桌面端重新发布同一应用 `wbapp_r7YnP5XG9F3iFhh4TM7cpm`（域名不变）。
- 恢复证据链（2026-11-25 21:20 北京时间核验）：实例后台 reconcile 自动清僵尸 claim → 重新配对 → 网关授权 → catalog 侧新绑定 **`bind_i11188Fl_3`（version 3，active）**，enrollment `enr_T0Pq4ZowguZCyIvLD_OetnUB` status=published；工作台 `published: true`（errorCode: null）；公网 agent-card 200。
- 未做：`verify-registry` job needs/`always()` 缺陷未修；冻源 PR 前置校验未做；WorkBuddy/商城平台资产未随本次更新。

## 2026-11-25 kiwi-catalog 0.5.29 registry 发布与生产部署

- 动因与发布源：修复商家海纳百川（catalog agent `cagt_7ASdi11188Fl`，merchant `mkt_m_OAF11HCJ-To`）「发布名片」重绑 409——0.5.28 的 `_insert_active_binding` 按「active 绑定数 +1」分配 `binding_version`，卸载重绑场景下与历史 revoked 行撞 `binding_id`（409）；修复 `fcc7253`（版本分配改为全历史 max+1）与 `bb644ba` 本已在 catalog main 但未发布，由新漂移巡检（PR #218）发现。catalog `21cd8d0c`（0.5.29 prepare）；kiwi 仓发布源 `f5cdf908`；shopping-cli `5ee21630` 未变、未重发。
- GitHub run：签名 dry-run [45475827691](https://github.com/harrylabsj/kiwi/actions/runs/45475827691) 成功；发布 [45504945623](https://github.com/harrylabsj/kiwi/actions/runs/45504945623) 成功，`publish=true`、channels=`kiwi-catalog`，经 `kiwi-release` 保护环境人工审批。本次为 release-readiness 门禁（PR #220）首次实际运行：选中通道 kiwi-catalog 放行；shopping-cli main 有未发布的 certifi bump，经 `acknowledge_unpinned_skips=true` 显式豁免留痕。
- registry 回读（2026-11-25 北京时间，手工）：PyPI `kiwi-catalog` latest=0.5.29，whl 与 sdist 均可下载；干净 venv `pip install kiwi-catalog==0.5.29` 并 import 通过。`verify-registry` job 因 needs 中含被跳过的其他 publish job 而整体 skipped（GitHub Actions 隐式 `success()` 语义，已知缺陷，本次仍为手工回读）。
- 生产部署（kiwi-hk，2026-11-25 15:05–15:08 北京时间）：
  - 部署前 DB 在线快照 `/opt/kiwi-catalog-backups/catalog-pre-0.5.29-20261125-070534.sqlite`（33M，sqlite backup API）。
  - 新目录 `/opt/kiwi-catalog-0.5.29-admin-0.2.28`；venv freeze 与 0.5.28 的唯一差异为 `kiwi-catalog==0.5.29`。`kiwi-catalog==0.5.29` 从官方 PyPI 安装（阿里云内网镜像当时尚未同步 0.5.29）；`kiwi-catalog-admin==0.2.28` 用服务器留存的 `/tmp/kiwi_catalog_admin-0.2.28-py3-none-any.whl`（sha256 `adc8880c…`，与 0.5.28 venv 的 direct_url.json 记录一致）。
  - 新 systemd drop-in `99999999999999999999999-package-0.5.29-admin-0.2.28.conf`（排序最后生效）；旧 0.5.28 drop-in 保留未动。回滚路径：将新 drop-in 改名 `.disabled` + `daemon-reload` + `restart` 即回 0.5.28 代码，DB 如有需要可从上述快照恢复。
  - schema：启动时自动迁移 `user_version` 59→60，`quick_check=ok`（部署后实测；事先按「无 schema 变更」预期，实际有一个轻量迁移，结果正常）。
  - 验证：服务 active、ExecStart 指向 0.5.29 目录；本地 `127.0.0.1:8600/health` 与公网 `https://catalog.kiwi.harrylabsj.com/health` 均 200；启动日志 issuer key / public origin 检查 OK、无报错；Caddy 访问日志显示 `/v1/*` 业务流量 200（根路径 404 为该纯 API 服务的固有行为）。
  - 修复在位与商家现场：运行代码 `kiwi_catalog/api/handlers/cloud_binding.py` 的 `_next_binding_version` 为 `coalesce(max(binding_version),0)+1`（全历史）；海纳百川当前两条绑定均 revoked（v1 `bind_i11188Fl_1`、v2 `bind_i11188Fl_2`），重绑将分配 v3，不再与 revoked 行冲突。端到端恢复待商家重试：先清除工作台 sessionStorage 键 `kiwi-catalog-connect-key`（或用无痕窗口重新登录），再点「发布名片」。
- 未做：npm `@harrylabsj/kiwi` 0.12.35、`@harrylabsj/kiwi-merchant-cloud` 0.12.35、shopping-cli 3.2.11、DSH 插件 0.1.4 未重发；`verify-registry` job 的 needs/`always()` 缺陷未修；WorkBuddy / 商城平台资产未随本次更新或审核。

## 2026-11-24 kiwi 0.12.35 registry 发布与生产部署

- 发布源：kiwi `2e07d088`（0.12.35 候选准备 `d8b7c9bb` 经 PR #214 合入为 `aad1a6f6`，真实验收回执经 PR #215 合入为 `72a77cf2`，V7 集成 `02dfdc12` 与冻源刷新经 PR #216 合入为 `2e07d088`）；catalog `d2d237a5`、shopping-cli `5ee21630` 未变，未重发。代码更新为 WorkBuddy 商家 onboarding 重构：统一「通过 Kiwi 网关发布商家名片」表述与 connect 流程、WorkBuddy V7 平台资产对齐、开通指引刷新。
- 真实端到端验收：2026-11-24T11:20Z 对生产目录 `https://catalog.kiwi.harrylabsj.com` 与真实商家 Veyquo（`mkt_veyquo_A0UPvj7XuYk` / `VQ-001` / 2 个）跑通 search → quote → negotiation → preaccept → agreement → handoff，非约束 agreement `agreement-01a20d49-0faf-736a-865e-11aeca39de26`；不下单、不付款、不锁库存。
- GitHub run：首次签名 dry-run [45385622686](https://github.com/harrylabsj/kiwi/actions/runs/45385622686) 在 Kiwi full verify 步 fail-closed（`SHIPPING_FOREIGN_AUTHORITY_CHANGED`：V7 集成改动冻源内文件但 sha256 未刷新），冻源刷新后 dry-run [45387223996](https://github.com/harrylabsj/kiwi/actions/runs/45387223996) 成功；发布 [45389500990](https://github.com/harrylabsj/kiwi/actions/runs/45389500990) 成功，channels=`npm,merchant-cloud`，经 `kiwi-release` 环境保护环境人工审批。部分渠道发布时 `verify-registry` job 被跳过，以下为发布后手工回读。
- registry 回读（2026-11-24 北京时间）：npm `@harrylabsj/kiwi` latest=0.12.35（metadata `dist.shasum`/下载 SHA-1：`a120ae774641e3e5d435b3e3aa2ba61238718d98`）；`@harrylabsj/kiwi-merchant-cloud` latest=0.12.35（SHA-1：`5c27955a87d309afedb21efcaf0a85db3412e632`）。干净安装 `@harrylabsj/kiwi@0.12.35` 通过。
- 生产部署（kiwi-hk，2026-11-24 20:31–20:38 北京时间）：
  - Veyquo runtime：切到 `/home/kiwi-merchant-v2/releases/kiwi-0.12.35-20261124-203126`；部署前状态快照 `/home/kiwi-merchant-v2/backups/pre-final-0.12.35-20261124-203126.tgz`；runtime 服务 active，A2A/MCP 子进程正常，`https://veyquo.com/.well-known/agent-card.json` 200、`/a2a` GET 405 为预期。
  - Veyquo workbench：切到 `/home/kiwi-merchant-v2/releases/kiwi-0.12.35-workbench-20261124-203126`；`https://veyquo.com/merchant/` 200。
  - 网关：`/opt/kiwi-gateway/app` 切到 `@harrylabsj/kiwi@0.12.35`，旧版保留在 `/opt/kiwi-gateway/app.prev-20261124-203133`；`/health` 与 OAuth metadata 均 200。
  - 部署后检查：kiwi-gateway、kiwi-merchant-v2、kiwi-workbench 均 active，三服务近 3 分钟 error 日志为空；catalog health 与 Veyquo catalog agent-card 均 200。
  - 部署后端到端复验：对生产目录 + Veyquo 重新跑通 search → quote → negotiation → preaccept → agreement → handoff（非约束，新 agreement `agreement-01a20d8b-ed37-7030-b0b4-09e477d66478`），未下单/未付款/未锁库存。
- 未变/未做：kiwi-catalog 0.5.28、shopping-cli 3.2.11、DSH 插件 0.1.4 未重发；WorkBuddy / 商城平台资产未随本次发布更新或审核。

## 2026-11-24 kiwi 0.12.34 registry 发布与生产部署

- 发布源：kiwi `31dd6d57`（0.12.34 候选准备 `bd28cb98`，真实验收回执与冻源刷新于 `31dd6d57`）；catalog `d2d237a5`、shopping-cli `5ee21630` 未变，未重发。代码更新包含 Pi/Chord 1.6.0 与微信 owner 会话能力。
- 真实端到端验收：2026-11-24T04:22Z 对生产目录 `https://catalog.kiwi.harrylabsj.com` 与真实商家 Veyquo（`mkt_veyquo_A0UPvj7XuYk` / `VQ-001` / 2 个）跑通 search → quote → negotiation → preaccept → agreement → handoff，非约束 agreement `agreement-01a20bca-a069-76dc-9d52-1c248c030ef5`；不下单、不付款、不锁库存。
- GitHub run：发布前签名 dry-run [45324209358](https://github.com/harrylabsj/kiwi/actions/runs/45324209358) 成功；发布 [45326524431](https://github.com/harrylabsj/kiwi/actions/runs/45326524431) 成功，channels=`npm,merchant-cloud`，经 `kiwi-release` 环境保护环境人工审批。部分通道发布时 `verify-registry` job 被跳过，以下为发布后手工回读。
- registry 回读（2026-11-24 北京时间）：npm `@harrylabsj/kiwi` latest=0.12.34（metadata `dist.shasum`/下载 SHA-1：`f36a9f26e06b715e49292cc40bbe815264aba467`）；`@harrylabsj/kiwi-merchant-cloud` latest=0.12.34（SHA-1：`c3ae87747e4b62f419157e695d3424c26a48706b`）。干净安装 `@harrylabsj/kiwi@0.12.34` 通过。
- 生产部署（kiwi-hk，2026-11-24 13:00–13:02 北京时间）：
  - Veyquo runtime：切到 `/home/kiwi-merchant-v2/releases/kiwi-0.12.34-20261124-125927`；部署前状态快照 `/home/kiwi-merchant-v2/backups/pre-final-0.12.34-20261124-130031.tgz`；runtime health 无 alert，A2A/MCP 子进程正常，`https://veyquo.com/.well-known/agent-card.json` 200、`/a2a` GET 405 为预期。
  - Veyquo workbench：切到 `/home/kiwi-merchant-v2/releases/kiwi-0.12.34-workbench-20261124-125927`；`https://veyquo.com/merchant/` 200。
  - 网关：`/opt/kiwi-gateway/app` 切到 `@harrylabsj/kiwi@0.12.34`，旧版保留在 `/opt/kiwi-gateway/app.prev-20261124-130109`；`/health` 与 OAuth metadata 均 200。
  - 部署后检查：kiwi-gateway、kiwi-merchant-v2、kiwi-workbench 均 active，三服务近 3 分钟 error 日志为空；catalog health 与 Veyquo catalog agent-card 均 200。
- 未变/未做：kiwi-catalog 0.5.28、shopping-cli 3.2.11、DSH 插件 0.1.4 未重发；WorkBuddy / 商城平台资产未随本次发布更新或审核。

## 2026-11-24 kiwi 0.12.33 registry 发布与生产部署

- 发布源：kiwi `aa66fc68`（0.12.33 候选准备 `dc43f1ba`，真实验收回执与冻源刷新于 `aa66fc68`）；catalog `d2d237a5`、shopping-cli `5ee21630` 未变，未重发。
- 真实端到端验收：2026-11-24T02:35Z 对生产目录 `https://catalog.kiwi.harrylabsj.com` 与真实商家 Veyquo（`mkt_veyquo_A0UPvj7XuYk` / `VQ-001` / 2 个）跑通 search → quote → negotiation → preaccept → agreement → handoff，非约束 agreement `agreement-01a20b68-3201-726a-94a0-0ae9fc2290c7`；不下单、不付款、不锁库存。
- GitHub run：发布前签名 dry-run [45311591459](https://github.com/harrylabsj/kiwi/actions/runs/45311591459) 成功；发布 [45314158644](https://github.com/harrylabsj/kiwi/actions/runs/45314158644) 成功，channels=`npm,merchant-cloud`，经 `kiwi-release` 环境保护环境审批。部分通道发布时 `verify-registry` job 被跳过，以下为发布后手工回读。
- registry 回读（2026-11-24 北京时间）：npm `@harrylabsj/kiwi` latest=0.12.33（metadata `dist.shasum`/下载 SHA-1：`7d553746f841b7b3e6526477252da87672040f13`）；`@harrylabsj/kiwi-merchant-cloud` latest=0.12.33（SHA-1：`769439b3ac9458dc86a1144d02f2823e3ee801a2`）。干净安装 `@harrylabsj/kiwi@0.12.33` 通过。
- 生产部署（kiwi-hk，2026-11-24 11:45–11:49 北京时间）：
  - Veyquo runtime：切到 `/home/kiwi-merchant-v2/releases/kiwi-0.12.33-20261124-114519`；部署前状态快照 `/home/kiwi-merchant-v2/backups/pre-final-0.12.33-20261124-114623.tgz`；runtime health 无 alert，A2A/MCP 子进程正常，`https://veyquo.com/.well-known/agent-card.json` 200、`/a2a` GET 405 为预期。
  - Veyquo workbench：切到 `/home/kiwi-merchant-v2/releases/kiwi-0.12.33-workbench-20261124-114519`；`https://veyquo.com/merchant/` 200。
  - 网关：`/opt/kiwi-gateway/app` 切到 `@harrylabsj/kiwi@0.12.33`，旧版保留在 `/opt/kiwi-gateway/app.prev-20261124-114717`；`/health` 与 OAuth metadata 均 200。
  - 部署后检查：kiwi-gateway、kiwi-merchant-v2、kiwi-workbench 均 active，三服务近 3 分钟 error 日志为空；catalog health 与 Veyquo catalog agent-card 均 200。
- 未变/未做：kiwi-catalog 0.5.28、shopping-cli 3.2.11、DSH 插件 0.1.4 未重发；WorkBuddy / 商城平台资产未随本次发布更新或审核。

## 2026-11-11 kiwi 0.12.28 发布与生产部署

- 发布源：kiwi `1b16cfac`，catalog `8933e797`，shopping-cli `5ee2163`；真实端到端验收回执已提交于 `95c82c2f`。
- GitHub run：[43005756999](https://github.com/harrylabsj/kiwi/actions/runs/43005756999)，build、五个 registry publish job 与 fail-closed `verify-registry` 均成功；发布前 dry-run 为 [43000526448](https://github.com/harrylabsj/kiwi/actions/runs/43000526448)。
- 生产 catalog：`/opt/kiwi-catalog-0.5.20-admin-0.2.18`，schema `54`，`integrity_check=ok`，`/v1/marketplace-platforms` 返回 jd/taobao/tmall，四个 dashboard tab 均为 200。部署前 DB 快照为 `/opt/kiwi-catalog-backups/catalog.sqlite.bak-20261111-181719`。
- 生产网关：`/opt/kiwi-gateway/app` 已升级到 npm 包 `@harrylabsj/kiwi@0.12.28`；`node dist/cli.js --version` 输出 `kiwi 0.12.28`，`https://merchant.kiwi.harrylabsj.com/health` 与 OAuth metadata 正常。旧应用保留在 `/opt/kiwi-gateway/app.prev-20261111-190520`。

## 2026-11-20 kiwi 0.12.32 / kiwi-catalog 0.5.28 registry 发布与生产部署

- 发布源：kiwi `477c62d6`（同一提交链上另有验收回执刷新 `c49c074a`、清单对齐 `477c62d6`），catalog `d2d237a5`，shopping-cli `5ee21630`（未变，未重发）。
- 真实端到端验收：2026-11-20T09:39Z 对生产目录 `https://catalog.kiwi.harrylabsj.com` 与真实商家 Veyquo（`mkt_veyquo_A0UPvj7XuYk` / `VQ-001` / 2 个）跑通 search → quote → agreement → handoff，回执写入 `build-inputs/release-acceptance.json`（非约束、标注【测试，请勿履约】，不下单/不付款/不锁库存）。
- GitHub run：[44714849898](https://github.com/harrylabsj/kiwi/actions/runs/44714849898)，`publish=true`，channels=`npm,merchant-cloud,kiwi-catalog`，经 `kiwi-release` 环境保护环境人工审批；发布前签名 dry-run 为 [44713120769](https://github.com/harrylabsj/kiwi/actions/runs/44713120769)。
- registry 回读（发布后手工执行）：npm `@harrylabsj/kiwi` latest=0.12.32、`@harrylabsj/kiwi-merchant-cloud` latest=0.12.32；PyPI `kiwi-catalog` latest=0.5.28。部分渠道发布时工作流跳过 fail-closed `verify-registry`，以上为本地 `npm view` / PyPI JSON 回读结果，不是 CI 证据。
- 未重发：`@harrylabsj/kiwi-dsh-plugin` 0.1.4、`shopping-cli` 3.2.11 版本未变。
- 生产部署（kiwi-hk，2026-11-20 19:20–19:40 北京时间）：
  - catalog：`/opt/kiwi-catalog-0.5.28-admin-0.2.28`，schema `56 → 59`，`integrity_check=ok`；部署前 DB 快照 `/opt/kiwi-catalog-backups/catalog.sqlite.bak-20261120-1920-pre0.5.28`（user_version 56）；旧 drop-in 已置 `.disabled-20261120`，keepalive 环境独立 drop-in 未动。健康检查本地/公网均 200，dashboard 三个子页 200，公开搜索命中 Veyquo。
  - 网关：`/opt/kiwi-gateway/app` 切换到 `@harrylabsj/kiwi@0.12.32`，备份保留在 `app.prev-20261120-1920` 与 `app.old-20261120-1920`；`/health` 与 OAuth metadata（`/.well-known/oauth-authorization-server`、`/.well-known/oauth-protected-resource`）均 200。
  - Veyquo 商家实例：runtime 切到 `releases/kiwi-0.12.32-20261120-1920`，workbench 切到 `releases/kiwi-0.12.32-workbench-20261120-1920`，均 0.12.32；状态快照 `backups/pre-0.12.32-20261120-1920.tgz`。A2A `https://veyquo.com/.well-known/agent-card.json` 200、`/a2a` 正常（GET 405 为预期），workbench `/merchant/` 公网 200，`merchant runtime health` 无 alert，shopping-cli 3.2.11 未动。
  - 部署后端到端复验：对生产目录 + Veyquo 重新跑通 search → quote → negotiation → preaccept → agreement → handoff（非约束，新 agreement `agreement-01a1f8b4-fd75-75e8-8ffa-78312f2ea864`），未下单/未付款/未锁库存。
- 未做：WorkBuddy / 商城平台资产更新与审核；本次不含平台侧发布。

## WorkBuddy 开放平台

以下专家、技能、连接器为 **2026-10-27 12:04–12:06 北京时间**开放平台列表只读盘点：当时均显示“已发布”。来源为当次项目工作区的 `work/deepseek-platform-live-inventory-20261027/REPORT.md` 和对应截图。列表版本不能证明线上正文、内嵌技能、实际运行包或当前状态；后续更新前需重新核查。资产 ID 保持原平台标识，不因名称修改而改变。

| 类型 | 资产 | 当次已发布版本 | 资产 ID |
|---|---|---:|---|
| Buddy | Kiwi商家 | v4 | `cb_jU2kgRjXVRjE2gmSjgyH` |
| 专家 | 开通顾问 | 0.1.2 | `oe_eee5ab6349f00203` |
| 专家 | 报价助理 | 0.1.2 | `oe_a2d0c6cc725719bd` |
| 专家 | 运营分析师 | 0.1.1 | `oe_85c8bf08203ad422` |
| 专家 | 客服教练 | 0.1.2 | `oe_ee7df761fbcdefee` |
| 专家 | 洽谈审批官 | 0.1.2 | `oe_8033777b83a3de05` |
| 专家团 | Kiwi开店团队 | 0.1.1 | `oe_a1da12ace3d9c62c` |
| 专家 | Kiwi 采购询价 | 1.0.1 | `oe_37aed7f0a679e6d4` |
| 技能 | Kiwi 云端接待部署 | 0.2.5 | `os_1ea25f81ce98fea3` |
| 技能 | Kiwi 商品导入表整理 | 0.1.3 | `os_32c612d72d2c3bcd` |
| 技能 | Kiwi 商家 AI 客服准备 | 0.1.1 | `os_dc3a52407574eb77` |
| 技能 | Kiwi 商家询价单整理 | 0.1.0 | `os_fe982aad31a98bfb` |
| 技能 | Kiwi 商品目录发布预检 | 0.1.0 | `os_50c0414417e25586` |
| 技能 | Kiwi 商家人工审批摘要 | 0.1.0 | `os_03cf120a20b00aae` |
| 技能 | Kiwi 三平台交易入口校验 | 0.1.0 | `os_9bc616f4fb80a452` |
| 技能 | Kiwi 商品源事实核验 | 0.1.0 | `os_6aedc97ac49e2d5b` |
| 技能 | Kiwi 商家报价方案准备 | 0.1.0 | `os_053e9e8722df80e6` |
| 技能 | Kiwi 商家运营数据解读 | 0.1.0 | `os_e64be8878bbb4349` |
| 连接器 | Kiwi 采购询价 | 1.0.1 | `oc_bd73f860e3e2b5d3` |
| 连接器 | Kiwi 商家运营 | 1.2.0 | `oc_0053ad85c92a6587` |

**Buddy v5：**2026-10-28 用户报告已提交、审核中。审核中不等于审核通过或当前生效版本；不要重复提交。若审核通过或驳回，应以平台回执更新时间和状态。Buddy 后续新版使用已有资产的“更新”入口，并在提交/发布前按用户要求逐项审批。

**2026-10-28 19:03 提交审核：**经用户明确批准，既有“网上购物助手”技能 `os_b8010c654e343791` 的 1.2.0 与“网购助手”专家 `oe_6038d999d6308c6b` 的 1.2.0 均已在 WorkBuddy 开放平台收到“已提交审核”回执，并回读列表均为“审核中 v1.2.0”（平台提示预计 7 个工作日内出结果）。原列表均显示 1.1.0 已发布；新 1.2.0 尚未确认审核通过或上线，不要重复提交。新候选支持优先发现 Kiwi 商品并在明确授权范围内询价和非绑定磋商；平台依赖绑定和真实流程尚待验证。技能审核通过后，按平台客服说明需使用者手动更新。

**其他候选：**“Kiwi购物智能体”专家改名、Kiwi 采购连接器及一键上云相关 0.12.9 更新均有本地候选，但本表没有其平台审核通过或发布证据，不列为已上线。线上是否需要重发由实际内容、依赖变化及用户审批决定；未修改资产不因版本号批量重传。

## 2026-11-14 Buddy 应用 1.8.2 本地候选

- 本地 `buddy-app.config.json` 升到 **1.8.2**：以 1.8.1 为基线合并线上 V5 的应用名/标题/简介、模型配置引导与技能状态提示；首页标题为 `Kiwi商家智能体·让生意自主进行`。
- 线上仍为 **已发布 v5**；1.8.2 未上传、未提交审核，不代表审核通过或上线。
- 平台导出快照与差异基线在 `integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/platform-export/2026-11-14/`；`npm run verify:workbuddy-platform` 校验差异。

## 2026-11-22 两个购物专家的本地候选验收

以 `1f355784` 为基线，删除闲置的旧启动器后重新打包。与删除前在同一代码基线上验证的两个专家 ZIP 逐文件比对，路径和内容全部一致。本次仅记录本地验收，未向 WorkBuddy 提审。

| 产品 | 候选包 | 本次 ZIP 的 SHA-256 | 断网 Linux amd64 验收 |
|---|---|---|---|
| Kiwi购物智能体 | `kiwi-procurement-expert-1.1.7.zip` | `c294b31bfb0d3f07f2b01675fc84048d9b5600d01aae7999f14336d93ac0deaf` | 9 组通过 |
| 网购助手 | `haina-ecommerce-expert-1.2.7.zip` | `b0eba1965f3663a7792c55259c3094fe5567c6c38175b5c417cca8482c4d3f02` | 9 组通过 |

两个容器均使用 Node 22.19.0、空用户目录和只读专家目录。实测各自返回 13 个工具，省略商家和传入空商家列表均返回 `merchant_required`；9 个按需加载的契约检查通过。询价和还价报文使用模拟商家验证，未向真实商家发送。[包级验收程序](../integrations/hosts/workbuddy/test/verify-expert-audit.mjs)

## 维护规则

1. 一次新版本至少记录：平台、产品/资产、精确版本、审核或上线状态、证据链接或回执、核验时间；需要时记录资产 ID、运行包 pin 及其验证结果。
2. 保留观察时间：本地候选、已提交审核、审核通过、已发布、已部署和运行验收是不同状态。
3. 不记录密钥、分享码、凭据或请求正文。以最新可信平台回执更新过时条目，并保留必要的历史证据。

## 2026-10-31 kiwi网络空间 1.0.4 提交审核

WorkBuddy连接器 `oc_bd73f860e3e2b5d3`：原1.0.3审核由用户撤回；本次1.0.4包由Root上传、平台解析资产ID一致，用户完成最终提交。Root随后在目标资产step=3页面核实“已提交审核”回执。当前为已提交审核，尚未证实审核通过或公开上线。

- 显示名：kiwi网络空间；包含PR #120的并发启动/锁等待修复。
- 源提交：`4c85566646eec54552d0351b3a93823eae16d366`；发布候选额外变更仅connector-meta版本与README。
- ZIP：`kiwi-sourcing-1.0.4-final-20261031.zip`；SHA256 `8dc813df535c488cc7fbabfc0a8fb5d641ba9ab26e9d8fefbcd9b2e863307f73`。
- 本地验证：40项测试、包清单39项、33个runtime与源提交一致；WorkBuddy本地专家只读搜索成功，不代表询价/磋商/交易验收。
- 详细记录：本轮工作区 `outputs/kiwi-connector-release-104-20261031.md`。平台不提供包哈希回读，此处哈希为实际选择上传的本地包。

## 2026-11-23 Kiwi购物智能体 1.1.11 本地包契约

仓库内 1.1.11 的内置 MCP 注册名为 `kiwi-procurement-buyer-1-1-11`，宿主工具前缀随注册名更新。买家持久目录仍由采购专家包的类型选择，不随服务名或版本变化；企业采购专家使用独立目录。此条仅记录本地契约，不是平台发布回执。

## 2026-11-10 Kiwi购物智能体 1.1.2 提交审核

WorkBuddy 专家 `oe_37aed7f0a679e6d4`：1.1.2 已提交审核，平台回执预计 7 个工作日内出结果；未证明审核通过或发布。上传包 `kiwi-procurement-expert-1.1.2-sigstore.zip`，本地 SHA-256 `85853883f966b873c73fa9610b9ef6414994fc54fc4695f39c9ee2449e13ecfa`。平台未回读包哈希。

专家自带 `kiwi-procurement-buyer` MCP，不依赖独立买家市场连接器；Kiwi npm 使用 latest，运行前校验来源、工具契约及实例身份。前提是同一系统用户只对应一个买家，不同买家不共享系统用户；仅支持 macOS/Linux，npm 12 且 sigstore 可用，缺失时提示用户升级，不自动变更全局环境。

WorkBuddy 5.9.3 本地测试专家与上传包除测试名称/标识外逐文件一致；2026-11-10 20:22 CST 调用内置 `kiwi_search` 搜索保温杯得到 `completed + has_candidates`，1 家商家、2 个待询价商品，未询价或下单。首次准备较慢，准备中请求未发出且需就绪后重试。20 项相关自动测试通过；未验证询价、磋商、交易及其他操作系统。被驳回的 `kiwi网络空间` 连接器未重新提交。

## 2026-11-10 网购助手 1.2.2 提交审核

WorkBuddy 专家 `oe_6038d999d6308c6b`：1.2.2 已提交审核，平台回执预计 7 个工作日内出结果；尚未证明审核通过或发布。上传 `haina-ecommerce-expert-1.2.2-candidate.zip`，本地 SHA-256 `87d5fa610e2b5a017570e06f5d380cd001bc7c4fc2b05e9398cc3f8ed923e13f`，平台未回读包哈希。

候选自带 `kiwi-shopping-buyer` MCP，不依赖独立买家市场连接器；沿用采购专家的单系统用户对应单买家数据范围及 npm latest 校验。WorkBuddy 5.9.3 测试专家除测试名称/标识外与包逐文件一致；20:42 CST 内置 `kiwi_search` 返回 `completed + has_candidates`，1 家商家和 2 个待询价商品，未询价或下单。20 项相关自动测试通过；首次准备期间请求未发出，准备完成后重试成功。询价、磋商和交易未验收。

用户要求新版发布后删除 Kiwi购物智能体和网购助手本地测试目录与数据；本次仍在审核，尚未发布，因此未执行清理。实际清理时须区分测试资产与两专家共用的买家数据。
