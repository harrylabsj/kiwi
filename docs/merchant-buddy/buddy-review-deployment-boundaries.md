# Buddy 本地审查与交付前置边界（A299）

本说明基于 kiwi `8a8e890` 与本地 catalog `2252517` 的只读审查。它是本地候选的
验证清单，不代表生产故障、平台提交、审核通过或上线许可。原自动上线保持 PAUSED。

## Sourcing connector 版本

下一版本地候选是 1.0.2，固定 `@harrylabsj/kiwi@0.12.3`，不再追随 dist-tag。
官方 npm metadata 的版本、Node >=22.19.0、tarball 和 SRI 出处记录在
`integrations/hosts/workbuddy/kiwi-sourcing/README.md`。官方 tarball 的 SRI 已核对，并静态确认
`dist/mcp/tools.js` 声明的 13 个工具与白名单一致；未安装或执行发布包。这不是 runtime
验收；目标 WorkBuddy 运行时版本、initialize 和 13 工具合同仍需交付前实测。
平台在审 1.0.1 是历史资产，此次本地修改不会替换或撤回它。

## Catalog 确认页部署前置

Catalog core 的 `verification_uri`、`login_url`、`authorization_url` 指向 `/portal/*`。
商家页面由私有 `kiwi-catalog-admin` 扩展提供；未挂载扩展时相应页面 404，核心 `/v1`
API 仍能启动及轮询。完成商家浏览器确认的部署必须安装和配置此扩展，或提供等价页面。
这是一项部署前置条件，不能仅由本地 checkout 推断生产缺失扩展。

部署环境后续验证步骤（需另行明确授权生产操作）：

1. 按 catalog 的 `docs/extensions.md` 核对安装包和 `KIWI_CATALOG_EXTENSIONS`；检查装载告警。
2. 核对实际使用的 fallback / FastAPI 路由栈，确认扩展在相应栈注册商家页面。
3. 使用部署环境测试身份创建 enrollment，打开响应的确认 URL，确认能登录、展示正确 runtime
   与配对信息，并由本人完成确认；再验证 device token 轮询进入后续绑定/发布流程。
4. 分别检查 connector 的 login_url 和 service status 的 authorization_url。

本地 pack 构建不访问这些线上 URL。不要以离线构建中的 HEAD 探测替代确认流程验收。

## 市场资产草稿

`market-draft/` 和 `platform-pack.zip` 是填写/导入验证草稿；`pending:<技能名>` 与 `scn-*`
是显式占位，现有 draft 校验允许它们。真实提交前须由平台返回的真实资产 ID 回填生成器，
并取得平台 schema 或导入验证结果。不得编造 ID，亦不得把尚未实测的 importer 行为写成
“导入必然失败”。专家审核状态和真实 ID 不因本次排序修改变化。

## Listing 公开 revision 与文件保留

`source_revision` 是 listing-record public 合同允许的字段，发布 whitelist 与 catalog
serialization 均保留它。当前 `file:<record.updated_at>` 是明确的来源版本投影；如需隐藏
更新时间，应先定义产品隐私口径与稳定、变更敏感的替代 revision，并验证 listing digest
和幂等键保持预期语义。仅凭字段含时间不能认定私有数据泄漏。

草稿与逐项回执用于预览审计、展示结果和部分失败/不确定结果的续办。现阶段未定义 GC
保留期限；持续预览会积累文件，属于容量和保留策略待定事项。制定 GC 时须区分未提交且
过期、已成功、partial、pending，保留审计与恢复所需依据；不能只因预览过期而自动删除
partial/pending 回执。服务声明一个 Runtime 进程拥有状态目录；跨进程共享目录需要独立
的协调设计与验证，不应把进程内多实例串行测试视作跨进程安全证明。

## 多仓版本证据

本地 catalog 为 0.5.3，kiwi portfolio 期望 0.5.5，本地缓存 origin/main 多 6 commits。
这些是本地审查输入差异；未 fetch、未检查生产安装包，不能推断远端最新状态或生产版本。
后续对齐本地审查输入与升级部署属于独立任务，此次不修改 catalog、不自动拉取或部署。
