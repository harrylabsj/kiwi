# WorkBuddy 账号资产归档状态 2026-10-31

目标是保存可追溯的专家、技能、连接器源码与 ZIP，支持从仓库重建。平台列表为 2026-10-31 只读观察；“审核中”不代表最新版本已发布，列表版本相同不代表本地文件与上传包字节一致。个人数据、凭据和运行数据不纳入归档。

## 目前已归档及构建入口

- kiwi网络空间 1.0.4 实际上传包未纳入仓库，SHA-256 `8dc813df535c488cc7fbabfc0a8fb5d641ba9ab26e9d8fefbcd9b2e863307f73`；仓库源码重建后40个包内文件摘要相同，容器摘要可不同。平台1.0.4审核中。
- `integrations/hosts/workbuddy/build-asset-zips.mjs`：独立构建每项 Kiwi 资产并输出版本、来源、状态及缺口报告；说明见 `docs/workbuddy-asset-zips-20261031.md`。本轮仓库状态：17个版本匹配的本地包及7个候选包；它们并不因此成为线上原始包。历史已发布源码未确证的项目记为HOLD。
- `integrations/hosts/workbuddy/account-assets/`：仅用于存放 Kiwi 自有 WorkBuddy 资产；本轮清理后不保留非 Kiwi 产品源码、包或副本。此前复制的健康顾问、领域学习、向上管理、认知觉醒、旅行、高考、物流、时间管理和社交助手资料分别归其自身来源仓维护。可见来源包括 `healthCare`、`map-domain-experts`、`upward-management-master`、`cogawaken`、`travel-expert`、`freight-reconciliation`、`time-management-master` 和 `wechat-social-assistant`；高考志愿静态插件来源在本机 WorkBuddy 插件缓存目录（无 Git 历史）。本清理不删除这些来源，也不改写历史提交。

本地 `account-assets` 中的健康顾问副本曾用于 PR #121 的快照级安全回归。该副本及测试现一并移除，避免 Kiwi 主库继续维护另一产品的代码；健康顾问模板、安全测试和告警处置应在 `healthCare` 主库继续维护。此次清理没有把 Kiwi 中的快照级安全测试迁移到 `healthCare`，也不据此声称上游回归覆盖已核实。`eslint.config.js` 中仅为这些副本添加的 lint 特例也已删除。

## 尚未闭合

- Kiwi采购专家历史已发布1.0.1、网购助手及网上购物助手历史1.1.0：未找到能确定对应线上内容的原始源码包；各自较新版本为本地/审核中候选。
- 时间管理大师0.2.5：本地仅找到0.2.0/0.2.2包及至0.2.4的缓存，未确认0.2.5源码或上传包。
- 物流运费对账专家0.3.0：来源仓 `freight-reconciliation` 的 tag `v0.3.0` 可重建候选ZIP；平台上传ZIP字节未回读，不能确定是原始上传包。
- 合同把关助手1.0.0：本地确认的源码版本仅到0.2.0，未找到匹配ZIP。
- 社交助手1.1.0：来源仓对应版本的应用源码不含WorkBuddy包；未找到对应WorkBuddy上传ZIP，仍为HOLD。此前的Kiwi副本已清理，源码归 `wechat-social-assistant` 主库维护。
- 平台上其余资产须逐项核准身份、来源、版本和可公开许可；同名或同版本不足以确认上传包一致。
- 健康顾问0.2.8归档源码曾触发10项CodeQL high：DOM text reinterpreted as HTML。经用户批准，重建源码已增加转义和类型约束；原始上传ZIP保持不变。代码级回归通过，远端CodeQL与真实UI验证仍待核实，不能将安全告警预先标为消除；修订源码重建包与原上传包不再完全相同。本PR仍不能宣称全部资产可精确复现。

执行根目录 `node integrations/hosts/workbuddy/build-asset-zips.mjs --out-dir /absolute/new/path` 可构建 manifest 中可用的Kiwi资产。各产品仅在自己的主库维护源码、测试和构建入口；这里的实际 Kiwi 1.0.4 ZIP 和 Kiwi 构建入口予以保留。以上不是平台上线或业务验收结论。
