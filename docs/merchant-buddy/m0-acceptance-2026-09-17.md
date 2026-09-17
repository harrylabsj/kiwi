# M0 端到端验收记录（2026-09-17）

状态：本地 API + Kiwi Buyer MCP 链路通过；本地商家门户的注册、验证与发布 UI 通过；WorkBuddy Buddy 首次绑定和专家客户端联调尚未完成。

## 环境

- Kiwi：`9828875`（`main`，验收时本次新脚本尚未提交）。
- kiwi-catalog：`fa04582`，本地 schema v30。
- catalog：`http://127.0.0.1:18617`，仅监听 `127.0.0.1`，SQLite 位于 `/private/tmp/kiwi-m0-workbuddy-acceptance/catalog.sqlite`；`GET /health` 返回 `ok: true`。
- 脚本：`scripts/m0-workbuddy-acceptance.sh`。默认自行拉起临时 v30 目录实例；`M0_CATALOG_URL=http://127.0.0.1:18617 bash scripts/m0-workbuddy-acceptance.sh` 可复用上述持续运行的本地实例。仅允许 loopback URL，账号、验证码、cookie、买家会话都只存临时目录并在退出时清除。

## 已实际通过

| 项目 | 结果与证据 |
| --- | --- |
| 商家注册与邮箱验证 | 本地 console 验证模式创建一次性账号，`/v1/accounts/me` 返回稳定 `merchant_id` |
| 草稿与发布 | 草稿搜索不到；明确发布返回 `publication_id`；本地持续实例的测试回执为 `mpub_AeLo8p8cugiwu4SG` |
| 目录搜索 | 商品词能查到正确商家，`source_kind=merchant_declared`、`inquiry_available=false`、`updated_at` 非空 |
| 买方 MCP 搜索 | `kiwi_search` 经真实 stdio JSON-RPC 与本地目录交互，返回同一 `merchant_id` 且 `inquiry_available=false` |
| RFQ 硬门 | `kiwi_request_quotes` 返回 `merchant_inquiry_unavailable`，本地 buyer SQLite 的 `mcp_tasks` 行数前后不变 |
| 主动关注与更新 | 设置一次性测试买家 `KIWI_CATALOG_SESSION` 后，`kiwi_follow_merchant` 成功；商家更新资料后 `kiwi_get_follow_updates` 拉到 `product_updated`，仅变更 FAQ 后拉到 `faq_updated` |
| 取消关注 | `kiwi_unfollow_merchant` 后再次更新，拉取结果为空 |
| 商家门户 UI | 用户在本地演示注册页完成邮箱验证；进入 `/portal/publications` 预览并确认发布，UI 回执 `publication_id=mpub_PZQSI5gbjWCRp_GK`，状态 `published`、版本 `v1`。截图：`/private/tmp/kiwi-m0-portal-publication-receipt-20260917.png` |
| 同一 UI 商家的买方 MCP | 搜索 `M0 UI 验收保温杯 20260917` 返回 `merchant_id=mkt_m0_5LzEHRvT5rs`、`source_kind=merchant_declared`、`inquiry_available=false` 和同一 `publication_id`；对该商家 RFQ 返回 `merchant_inquiry_unavailable`，买方 `mcp_tasks` 行数 `0 → 0` |

上述链路在脚本自行启动的临时目录实例和持续运行的本地目录实例上各跑通一次。脚本仅输出非敏感结果，不保存或打印账户密钥。

## WorkBuddy 环境观察与待验收

- WorkBuddy 开放平台企业账号下，“Kiwi 采购询价”专家 `oe_37aed7f0a679e6d4` 显示**已发布 v1.0.0**；依赖连接器 `oc_bd73f860e3e2b5d3` 显示**已发布 v1.0.0**。
- 同一企业账号的 Buddy 应用列表显示**“暂未发布”**。因不存在可打开的商家 Buddy 预览，当前不能判断“首次绑定商家 MCP 是否阻塞未部署服务器的新商家”。列表截图：`/private/tmp/workbuddy-m0-buddy-app-list-20260917.png`。
- 已发布专家/连接器目前没有指向本地 `127.0.0.1:18617` 的隔离配置；本地测试商品不会自动出现在该公开版本。WorkBuddy 中的专家真实检索、关注和事件拉取仍须用**预览/测试连接器**指向本地目录，或先部署到受控 staging 后验收；不得把本地脚本通过误写成 WorkBuddy 客户端已通过。
- WorkBuddy 开放平台“创建 Buddy 应用”表单已验证：测试名称/简介与“商家自营 → B2B”类目可以填写；头像必填（PNG/JPG，至少 96×96，不超过 100KB），名称提交后不可修改。浏览器扩展上传受限后，用户明确要求直接上传；普通 Chrome 系统文件选择器已成功上传 `/private/tmp/kiwi-m0-test-icon-128.png`（128×128，21KB），表单可见头像预览。
- 应用级“授权列表”和“OAuth 回调地址”均标为必填；当前 M0 没有明确需要的 WorkBuddy Open API 权限，也没有可用的应用回调服务，因此未选择额外权限或填写虚假的 URL。“提交审核”仍为禁用状态。**测试应用未创建、未提交审核、没有预览链接**；这属于 Buddy 应用自身的授权前置，与第 1 版商家 MCP OAuth 连接器是两件事。
- WorkBuddy “发布连接器”流程要求上传 ZIP → 平台解析并生成连接器 ID → 确认信息 → 提交审核。现有 `kiwi-merchant` OAuth ZIP 离线校验通过（15 个工具；sha256 `1073f0ced313520c0c872c89fd0b90b889aebf5668991f0a05df2deb7af1a1cc`），但 WorkBuddy 浏览器扩展拒绝自动附加 ZIP，人工接管超时，因此**ZIP 未上传，连接器未提交审核或发布**。
- 更关键的上架条件：现有包 `mcp.json` 固定连接 `https://merchant.kiwi.harrylabsj.com/mcp`，该服务当前是单个 Veyquo 商家实例；服务器检查显示 `admin-credentials.json` 尚不存在，OAuth 授权页不能完成管理员登录。此包不能直接以面向全部商家的正式连接器发布。通用 OAuth 连接器需要一个能在认证后按商家路由的共享入口；若先做单商家验收包，必须明确其仅限 Veyquo 测试且不能误导其他商家。

## WorkBuddy 剩余执行步骤

1. 确定 M0 Buddy 应用需要的最小 WorkBuddy 应用级权限和真实 HTTPS 回调服务，配置后提交创建审核；不要为通过表单而申请不需要的用户数据权限或填写不能处理授权码的假 URL。
2. 审核通过并取得预览后，以未部署 Kiwi Merchant 专属服务器的新商家身份打开 Buddy；观察是否出现强制商家 MCP 首次绑定，记录能否直接使用“目录注册与发布（第 0 版）”。
3. 为采购专家准备只指向本地/受控 staging v30 catalog 的测试连接器版本，在 WorkBuddy 内实际调用 `kiwi_search` 搜索商品 `M0 UI 验收保温杯 20260917`，核对 `merchant_id=mkt_m0_5LzEHRvT5rs` 与 `inquiry_available=false`。
4. 在客户端尝试对上述 M0 商家询价、关注、拉取更新、取消关注；核对工具回执与截图。发布与关注操作只在测试实例执行，不修改公开连接器/专家的生产配置。
5. 决定商家连接器上架形态：正式多商家入口或仅限 Veyquo 的隔离验收包。前者需实现共享 OAuth/租户路由；后者需先设置管理员账户并验证真实 OAuth 全流程。两者都必须先在 WorkBuddy 平台完成连接器审核，再在 Buddy 中绑定对应连接器 ID。

完成条件：以上 WorkBuddy 实机步骤通过，且首次绑定策略明确确定为“第 0 版可先使用、商家 MCP 延后至第 1 版”。
