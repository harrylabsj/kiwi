# 商家连接器上架素材包（提交前必读）

状态（2026-09-24）：**v1.1.1 已重新提交 WorkBuddy 审核**，新连接器 ID `oc_0053ad85c92a6587`，平台列表显示「审核中」。通过后由 Buddy 应用内置引用；不作为要求用户另行安装的市场产品。旧资产 `oc_c86216e2a36110bf` 已撤回，不得复用。腾讯客服要求补充可登录的专用 Kiwi 商家测试账号以完成 OAuth 测试；该账号尚未选定，测试账号邮件尚未发送。
历史（2026-09-20 核对）：新商家连接器 `oc_c86216e2a36110bf` 曾提交 WorkBuddy 审核，平台列表显示 v1.1.0，未发布即被撤回。旧 v1.0.0 草稿 `oc_f6eb7fea361ac64e` 已由用户删除。AI 客服准备技能 `os_dc3a52407574eb77` 已提交审核；Buddy 应用基础审核仍受平台授权表单阻碍。依据：[商家连接器独立发布计划](generic-merchant-connector-release-plan.md)、[平台核验记录](workbuddy-connector-platform-verification-2026-09-17.md)、[第 1 版设计](../v1-product-flow-and-onboarding-design.md)。

2026-09-18 首次提交回执：生产网关已运行 Kiwi 0.9.0 + 安全修复 `d9ab95a`（构建源为隔离工作树 `9baebd4`），`/health` 与 OAuth 元数据公网正常，旧 `dist` 保留在 `/opt/kiwi-gateway/app/dist.prev-108c25e9` 供回滚。WorkBuddy 解析 `kiwi-merchant-gateway-1.0.0.zip` 后生成新连接器 ID **`oc_f6eb7fea361ac64e`**，选择「商家自营 - B2b(商品批发/门店管理)」类目。审批通过及用户侧真实 OAuth/工具预览尚待验收。

2026-09-20 同 ID 更新尝试（历史）：经用户授权撤回旧审核后，资产为「草稿 v1.0.0」，原 ID 保留；在同 ID 的包配置页上传 v1.1.0，解析页、确认页均显示原 ID / v1.1.0 / 新目录能力文案，提交页提示成功。然而返回资产列表刷新仍显示「审核中 v1.0.0」；再次撤回并打开编辑页仍显示 **v1.0.0 与旧版实例能力文案**，证明该更新没有持久化替换。用户随后删除了旧草稿；该 ID 仅作历史记录，**不得用于 Buddy 应用配置**。

2026-09-20 新资产提交回执：直接上传下述 v1.1.0 包，平台生成 **`oc_c86216e2a36110bf`**；解析、确认页均显示 v1.1.0 与准确目录能力介绍，服务类目为「商家自营 - B2b(商品批发/门店管理)」。提交页提示审核已受理，返回资产列表确认 **「审核中 v1.1.0 · oc_c86216e2a36110bf」**。这不是已发布或 OAuth 实机验收通过。

**本轮提交顺序**：准备 OAuth 测试账号 → 上传 v1.1.1 生成新的连接器资产 ID → 提供测试账号供平台审核 OAuth 与 6 个工具 → 审核通过后把新 ID 配置到 Buddy 内置连接器 → Buddy 应用创建审核/草稿配置 → 预览实机验收 → 应用最终审核。用户侧仍从 Buddy 内绑定，不要求独立安装商家连接器。基础信息创建审核不等于应用已上线。

---

## 1. 连接器包

| 项 | 值 |
| --- | --- |
| 目录 | `integrations/hosts/workbuddy/kiwi-merchant-gateway-connector/` |
| 内容 | `connector-meta.json`、`mcp.json`、`icon.svg`（3 文件，约 9 KB） |
| source | `kiwi-merchant`（**需先在平台核对唯一性**） |
| 入口 | `https://merchant.kiwi.harrylabsj.com/mcp`（固定 HTTPS，OAuth） |
| 回调 | `workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback`（按 source 派生；拒绝时回退 loopback） |
| 声明工具 | **6 个 `kiwi_catalog_*`**（第 0 版目录能力：身份 / **经营汇总（关注数+浏览量+各资料表现）** / 草稿 / 请求发布 / **读单条资料（含可编辑内容）** / 撤回）。按[「网关不碰实例」](merchant-connector-deployment.md)原则（部署说明 §0），**没有** `kiwi_merchant_*` 之类的实例工具——商家实例独立部署、直接与买家做 A2A |

重新生成（提交前必须重跑，并核对 sha256）：

```sh
node integrations/hosts/workbuddy/package-gateway-connector.mjs --check
node integrations/hosts/workbuddy/package-gateway-connector.mjs --out /abs/path/kiwi-merchant-gateway-<version>.zip
shasum -a 256 /abs/path/kiwi-merchant-gateway-<version>.zip
```

**本轮提审包（2026-09-24）**：`/private/tmp/kiwi-merchant-gateway-1.1.1.zip`，SHA-256 `e7b665ee24c57948219f383ddd375827f515c4db5b86b1f2c89cbaa593612fac`。已核对 `connector-meta.json.version=1.1.1`、6 个 `kiwi_catalog_*` 工具、OAuth MCP 入口与凭据扫描。审核账号就绪后上传并提交审核。
**旧包禁用**：先前文件名为 `kiwi-merchant-gateway-1.1.0.zip`（摘要 `832d4b58…`）的 ZIP **包内仍写 v1.0.0**，不能用于新版本提交。

ZIP 只含 `connector-meta.json`、`mcp.json`、`icon.svg`；**提交前必须按上面的命令重跑并核对 sha256**，
不要把不同版本的摘要混用（历史上 1.0.0 的摘要是 `6bda6977…`，与本次不可混）。

离线校验覆盖（脚本 + 测试，均随 CI 跑）：
- 包结构与字段合法性；`url` 必须 https + `/mcp` + **不得落在商家自有实例域名**；
- `tools` 声明与 `src/merchant-gateway/catalog-tools.ts` 实现**全等**（`tests/workbuddy-gateway-connector.test.ts`）；
- 包内无疑似凭据（`cmt_` / `mcp_at_` / Bearer / API key 形态）。

## 2. 平台步骤（连接器）

1. 已上传并提交 v1.1.1；资产 ID `oc_0053ad85c92a6587`，当前审核中。
2. 不复用已撤回 `oc_c86216e2a36110bf`、已删除 `oc_f6eb7fea361ac64e` 或买方 `oc_bd73f860e3e2b5d3`。
3. 通过客服要求的邮箱渠道补交专用 Kiwi 商家测试账号，供审核方测试 OAuth 与 6 个目录工具。
4. 审核通过后核对真实 `tools/list` 与 OAuth 回跳，再把新 ID 配置到 Buddy 应用内置连接器字段。
5. **若平台拒绝 `workbuddy://` 私有协议回调**：确认回退 `http://127.0.0.1:{动态端口}/oauth/callback` 是否被接受；两条都不行则停下评审，不改入口形态。

## 3. Buddy 应用

配置草稿：`integrations/hosts/workbuddy/kiwi-merchant-buddy/buddy-app.config.json`（v1.5.0，本地人工配置草稿，非官方导出格式；内置连接器 ID 待 v1.1.1 审核通过后回填）；头像：同目录 `avatars/kiwi-merchant-buddy.png`（256×256、74KB）。

**两类回调不要混填**（本次重写的重点）：

| 字段 | 填什么 |
| --- | --- |
| 应用级「授权回调URL」 | 本应用自己的 HTTPS 回调服务（接收平台 Open API 授权码）。当前不申请 Open API 权限 → 留空；确需权限时**先部署可处理授权码的真实回调**，不得填占位 URL |
| 连接器回调 | `workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback`（属于连接器包，不属于应用表单） |

应用侧要点（**2026-09-18 收窄后**）：
- 模式：**只有「目录注册与发布」**（用 `kiwi_catalog_*`，发布必须引导到门户确认）。
- **没有实例相关能力**（商品查看 / 询价处理 / 变更草稿，以及此前的「连接我的 Kiwi Merchant 服务」引导）——按[「网关不碰实例」](merchant-connector-deployment.md)原则（部署说明 §0）刻意去掉，不是缺失：网关不持有实例地址与凭据、不代理实例工具；商家实例独立部署、直接与买家做 A2A。
- 平台后台逐字段核对清单见 `kiwi-merchant-buddy/README.md`。

> 提示：若平台后台仍留有旧版实例模式配置，以当前 v1.4.2 的一个模式和五个胶囊为准。AI 客服准备是独立技能，仅起草 FAQ/回复，不接待真实顾客。

`kiwi-merchant-cs-prep` 技能包：`/private/tmp/kiwi-merchant-cs-prep-0.1.0-release-20260920.zip`，sha256 `daa79e9842f2ae5df867a69a3dc5aeac883d3d8c4df8eb3509ca035d8d39fc1d`。平台已解析并生成 ID `os_dc3a52407574eb77`，已提交审核（市场分类「商业运营」、服务类目「商家自营 - B2b(商品批发/门店管理)」）；**尚未发布**，审核通过后再加入应用市场。

Buddy 基础审核表单已上传 256×256 PNG，填写 `Kiwi 商家运营工作台`、第 0 版准确简介与「商家自营 - B2b」类目，但「提交审核」仍被禁用。权限菜单没有“无权限”项，仅提供读取资料/任务/本地助理等不需要的 Open API 权限；应用级 OAuth 回调留空时不能提交。**不为过表单而申请无关权限或填写无效回调。** 需平台明确支持无应用级权限的 Buddy 创建，或说明正式的最小授权/真实回调方案。

## 4. 提交前必须确认的外部事项

| # | 事项 | 由谁解决 | 未确认时的后果 |
| --- | --- | --- | --- |
| 1 | `kiwi-merchant` source 是否已被占用 | 曾接受 v1.1.0 包；v1.1.1 重新上传时再次核对 | source 冲突会让包解析失败或与既有资产混淆 |
| 2 | 新连接器 ID（平台生成） | v1.1.1 上传后生成；旧 ID 已撤回 | 获批后填入 Buddy 内置连接器；用户仍从 Buddy 内绑定使用 |
| 3 | `merchant.kiwi.harrylabsj.com` 从 Veyquo 单实例切换为网关入口 | 已完成；`/health` 返回 `kiwi-merchant-entry` | 需维持公网健康与安全修复版本 |
| 4 | 平台对 `workbuddy://` 私有协议回调与 loopback 回退的接受情况 | 平台预览 | 授权无法回跳 |
| 5 | 首次绑定能否在没有商家账号/自部署服务时完成目录注册 | 平台预览 | 新商家无法打开即用；需调整绑定/注册动线 |
| 6 | 技能 `os_dc3a52407574eb77` 的审核与市场可见性 | 平台技能资产 | 未发布时不得在 Buddy 市场引用 |
| 7 | Buddy 创建页如何在不申请无关 Open API 权限时提交 | 平台说明/支持 | 当前提交按钮禁用，应用 ID 尚未生成 |

## 5. 随提交附上的证据

- 第 0 版 WorkBuddy 实机检查单：`workbuddy-e2e-checklist.md`（必须重新执行并留存预览证据；离线断言不能替代）；
- 契约锁定：`tests/workbuddy-gateway-connector.test.ts`、`tests/buyer-tool-contract.test.ts`（买方九工具 inputSchema 基线）；
- 安全边界：`merchant-connector-deployment.md` §0（网关不碰实例、不持有实例凭据）；
- 部署说明：`merchant-connector-deployment.md`（同机拓扑、反代分流、凭据清单与轮换、回滚）。

## 6. 被拒或需回滚时

1. 撤回/下架连接器版本（平台操作），**不影响**：目录里的公开资料（在 kiwi-catalog）、商家的商品/库存/接待（在商家实例）、买方连接器与采购专家（完全独立）。
2. 反代把 `merchant.kiwi.harrylabsj.com` 摘掉或置 503；网关进程可继续运行（已连接商家不受影响）。
3. 若已发出新 ID 但应用未通过：保持应用未发布状态，修正后重新提交；不要用买方 ID 或单实例包顶替。

## 7. 明确不做

- 不把 `kiwi-merchant-connector-oauth/`（指向 Veyquo 单实例）作为通用商家入口提交；
- 不为通过表单而申请不需要的 Open API 权限或填写无效回调；
- 不在连接器包内写任何密钥、商家实例地址或内部令牌；
- 不在未验证入口可用的前提下宣称"已支持异地自托管"（出站钉住已实现，但真实公网部署的端到端仍待部署环境）。
