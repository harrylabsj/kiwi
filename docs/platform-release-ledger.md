# Kiwi 平台发布版本台账

最近一次发布与生产部署核验为 2026-11-24（北京时间），各平台状态以对应条目的核验日期为准。本表记录**已观察到的版本与当时状态**，不是实时查询；候选代码、注册表版本、平台审核和实际云端运行分开记录。部署、上线或发布新版本后，应补充平台链接、版本、状态、核验时间与回执；不得以代码提交或审核提交代替上线证据。

## npm 与 PyPI

| 平台 | 产品 | 已确认版本 | 证据与限制 |
|---|---|---:|---|
| npm | `@harrylabsj/kiwi` | 0.12.33 | 2026-11-24 portfolio run [45314158644](https://github.com/harrylabsj/kiwi/actions/runs/45314158644) 发布；发布后手工回读 npm latest=0.12.33，并下载 tarball 核验 SHA-1 与发布日志一致（部分渠道发布时 `verify-registry` job 不运行）。[npm 版本页](https://www.npmjs.com/package/@harrylabsj/kiwi/v/0.12.33)。 |
| npm | `@harrylabsj/kiwi-merchant-cloud` | 0.12.33 | 2026-11-24 同一 portfolio run 发布；手工回读 npm latest=0.12.33，并下载 tarball 核验 SHA-1 与发布日志一致。[npm 版本页](https://www.npmjs.com/package/@harrylabsj/kiwi-merchant-cloud/v/0.12.33)。 |
| npm | `@harrylabsj/kiwi-dsh-plugin` | 0.1.4 | 2026-11-11 portfolio run 发布并回读核验；npm 可查 0.1.4。[npm 版本页](https://www.npmjs.com/package/@harrylabsj/kiwi-dsh-plugin/v/0.1.4)。 |
| PyPI | `kiwi-catalog` | 0.5.28 | 2026-11-20 portfolio run [44714849898](https://github.com/harrylabsj/kiwi/actions/runs/44714849898) 发布，发布后手工回读 PyPI latest=0.5.28；**生产 kiwi-hk 已于同日部署 0.5.28 + admin 0.2.28，schema user_version=59**。[PyPI 版本页](https://pypi.org/project/kiwi-catalog/0.5.28/)。 |
| PyPI | `shopping-cli` | 3.2.11 | 2026-11-11 portfolio run 发布并回读核验；PyPI 可查 3.2.11。[PyPI 版本页](https://pypi.org/project/shopping-cli/3.2.11/)。 |

上表确认指定版本可查，不声称它们必然仍是 registry 当前 latest（2026-11-24 已确认 `@harrylabsj/kiwi` latest=0.12.33、`@harrylabsj/kiwi-merchant-cloud` latest=0.12.33；2026-11-20 已确认 `kiwi-catalog` latest=0.5.28）。`kiwi-catalog-admin` 0.2.18 已推送私有 tag `v0.2.18`，并作为生产 catalog 的扩展安装；它不是公开 registry 制品。

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
