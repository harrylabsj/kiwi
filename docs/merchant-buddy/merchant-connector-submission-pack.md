# 商家连接器上架素材包（提交前必读）

状态：**WorkBuddy 审核中，尚未发布**（2026-09-18）。依据：[商家连接器独立发布计划](generic-merchant-connector-release-plan.md)、[平台核验记录](workbuddy-connector-platform-verification-2026-09-17.md)、[第 1 版设计](../v1-product-flow-and-onboarding-design.md)。

2026-09-18 提交回执：生产网关已运行 Kiwi 0.9.0 + 安全修复 `d9ab95a`（构建源为隔离工作树 `9baebd4`），`/health` 与 OAuth 元数据公网正常，旧 `dist` 保留在 `/opt/kiwi-gateway/app/dist.prev-108c25e9` 供回滚。WorkBuddy 解析 `kiwi-merchant-gateway-1.0.0.zip` 后生成新连接器 ID **`oc_f6eb7fea361ac64e`**，选择「商家自营 - B2b(商品批发/门店管理)」类目，平台资产列表显示「审核中 v1.0.0」。平台提示预计 7 个工作日内出结果；审批通过及用户侧真实 OAuth/工具预览尚待验收。

**提交顺序**：先连接器（拿到平台生成的新 ID）→ 再 Buddy 应用（引用该 ID）→ 最后预览与实机验收。**不得**先提交应用。

---

## 1. 连接器包

| 项 | 值 |
| --- | --- |
| 目录 | `integrations/hosts/workbuddy/kiwi-merchant-gateway-connector/` |
| 内容 | `connector-meta.json`、`mcp.json`、`icon.svg`（3 文件，约 9 KB） |
| source | `kiwi-merchant`（**需先在平台核对唯一性**） |
| 入口 | `https://merchant.kiwi.harrylabsj.com/mcp`（固定 HTTPS，OAuth） |
| 回调 | `workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback`（按 source 派生；拒绝时回退 loopback） |
| 声明工具 | 5 个 `kiwi_catalog_*`（第 0 版目录能力）；第 1 版实例工具按商家实例**动态出现**，故不静态声明 |

重新生成（提交前必须重跑，并核对 sha256）：

```sh
node integrations/hosts/workbuddy/package-gateway-connector.mjs --check
node integrations/hosts/workbuddy/package-gateway-connector.mjs --out /abs/path/kiwi-merchant-gateway-<version>.zip
shasum -a 256 /abs/path/kiwi-merchant-gateway-<version>.zip
```

本次实际提交产物：`kiwi-merchant-gateway-1.0.0.zip`，sha256 `6bda6977eaea72bd6f5d2c452955511c0f10b16ba82ac80384686e1f19db927f`。ZIP 只含 `connector-meta.json`、`mcp.json`、`icon.svg`；与早期 1.1.0 试包的摘要不可混用。

离线校验覆盖（脚本 + 测试，均随 CI 跑）：
- 包结构与字段合法性；`url` 必须 https + `/mcp` + **不得落在商家自有实例域名**；
- `tools` 声明与 `src/merchant-gateway/catalog-tools.ts` 实现**全等**（`tests/workbuddy-gateway-connector.test.ts`）；
- 包内无疑似凭据（`cmt_` / `mcp_at_` / Bearer / API key 形态）。

## 2. 平台步骤（连接器）

1. 上传 ZIP → 平台解析并生成连接器 ID → 核对信息（名称、source、工具、回调）。
2. 已记录 **新连接器 ID `oc_f6eb7fea361ac64e`**（与买方 `oc_bd73f860e3e2b5d3` 不同）。
3. 已提交审核；审核通过后继续记录正式发布状态、进行 WorkBuddy 实机 OAuth 和工具验收，再把该 ID 配置到商家 Buddy 应用。
4. **若平台拒绝 `workbuddy://` 私有协议回调**：确认回退 `http://127.0.0.1:{动态端口}/oauth/callback` 是否被接受；两条都不行则停下评审，不改入口形态。

## 3. Buddy 应用

配置草稿：`integrations/hosts/workbuddy/kiwi-merchant-buddy/buddy-app.config.json`（v1.1.0，已按两个连接器方案重写）。

**两类回调不要混填**（本次重写的重点）：

| 字段 | 填什么 |
| --- | --- |
| 应用级「授权回调URL」 | 本应用自己的 HTTPS 回调服务（接收平台 Open API 授权码）。当前不申请 Open API 权限 → 留空；确需权限时**先部署可处理授权码的真实回调**，不得填占位 URL |
| 连接器回调 | `workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback`（属于连接器包，不属于应用表单） |

应用侧要点（**2026-09-18 收窄后**）：
- 模式：**只有「目录注册与发布」**（用 `kiwi_catalog_*`，发布必须引导到门户确认）。
- **没有实例相关能力**（商品查看 / 询价处理 / 变更草稿，以及此前的「连接我的 Kiwi Merchant 服务」引导）——按[「网关不碰实例」](merchant-connector-deployment.md)原则（部署说明 §0）刻意去掉，不是缺失：网关不持有实例地址与凭据、不代理实例工具；商家实例独立部署、直接与买家做 A2A。
- 平台后台逐字段核对清单见 `kiwi-merchant-buddy/README.md`。

> 提示：`buddy-app.config.json` 在 1.2.0 已按上述重写。若平台后台仍留有旧版本的模式配置，按 1.2.0 覆盖。

## 4. 提交前必须确认的外部事项

| # | 事项 | 由谁解决 | 未确认时的后果 |
| --- | --- | --- | --- |
| 1 | `kiwi-merchant` source 是否已被占用 | 平台已接受包并生成新 ID；正式发布时再核对 | source 冲突会让包解析失败或与既有资产混淆 |
| 2 | 新连接器 ID（平台生成） | 已获得 `oc_f6eb7fea361ac64e` | 审核通过后供 Buddy 应用引用 |
| 3 | `merchant.kiwi.harrylabsj.com` 从 Veyquo 单实例切换为网关入口 | 已完成；`/health` 返回 `kiwi-merchant-entry` | 需维持公网健康与安全修复版本 |
| 4 | 平台对 `workbuddy://` 私有协议回调与 loopback 回退的接受情况 | 平台预览 | 授权无法回跳 |
| 5 | 绑定实例后新增工具是否需要 Buddy 侧重连/刷新 | 平台预览 | 商家绑定后可能看不到实例工具，需在文案里给出「重连一次」的指引 |

## 5. 随提交附上的证据

- 跨仓端到端验收：`bash scripts/v1-merchant-connector-acceptance.sh`（20 项断言，输出含 `publication_id`、工具清单、隔离与离线恢复结论）；
- 契约锁定：`tests/workbuddy-gateway-connector.test.ts`、`tests/buyer-tool-contract.test.ts`（买方九工具 inputSchema 基线）；
- 安全设计：`merchant-instance-pairing-design.md`（绑定=控制权证明、配对码、凭据轮换/吊销、出站钉住、mTLS 决策）；
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
