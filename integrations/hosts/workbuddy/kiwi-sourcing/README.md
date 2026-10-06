# Kiwi 采购询价 WorkBuddy Connector

该目录是提交到 WorkBuddy 连接器市场的完整源包。采用 WorkBuddy 托管 Node 22 运行时（发布包要求 Node >=22.19.0），
通过 `npx` 启动 `@harrylabsj/kiwi@0.12.3` 的 stdio MCP Server。

本地下一版候选为 **1.0.2**，尚未提交审核。平台已送审的 1.0.1（13 工具 + latest）
是独立的历史资产；本地修改不代表其已更新、撤回或审核通过。

固定版本依据：2026-10-07 读取官方 npm metadata
`https://registry.npmjs.org/@harrylabsj%2fkiwi/0.12.3`，记录包名/版本、
`engines.node=>=22.19.0`、`bin.kiwi=dist/cli.js` 与公开发布物：

- tarball：`https://registry.npmjs.org/@harrylabsj/kiwi/-/kiwi-0.12.3.tgz`
- SRI：`sha512-anOf/ufyK1Q3RUIUCSkUAQDEE9KIqKkZ0VJ0eXTGUNZHVDmj2DMCeQyiMGqQSglZWIkQHmFxcMzu1zuiF12yMw==`

同日下载上述官方 tarball，仅计算 SRI 并静态读取包内 `package.json` 与
`dist/mcp/tools.js`：SRI 相符，声明的 13 个工具与本 connector 白名单一致（含 4 个关注工具）。
未安装或执行该发布包；静态合同不是目标客户端 runtime 验收。上述 SRI 是审查出处记录，
不是新增的启动校验机制；客户端 `initialize` / `tools/list` 仍需按下节实测。

## 架构边界

```text
WorkBuddy 对话
  └─ Kiwi 采购询价 Connector（本目录）
       └─ kiwi mcp serve / Buyer Core
            ├─ 本地 SQLite：task、approval、agreement
            ├─ kiwi-catalog：发现供应商
            └─ 独立 Kiwi Merchant Agent：商品、库存、报价、KNP/A2A
```

连接器是买家入口，不是商家运行时。`kiwi merchant` 继续独立部署并保有商家私有数据、
凭证、定价规则和审计 Ledger。未来可增加“Kiwi 商家经营助手”Buddy 应用，但它应调用既有
Merchant HTTP/SSE 接口，只作为经营控制面，不把商家运行时迁入 WorkBuddy。

## 配置与安全

- 一个连接器只配置一个 stdio MCP Server；
- npm 包固定为 `@harrylabsj/kiwi@0.12.3`；校验器拒绝 dist-tag、版本范围及重复包参数；
- 启动时需能访问 npm registry（或配置的镜像），网络不可用时可能无法检查或下载包；
- 单次连接超时 30 秒，A2A 调用预算 15 秒；
- 首版不配置 `auth_mode`，不在包内放 Token、API Key 或商家凭证；
- `kiwi_accept_agreement` 和 `kiwi_handoff` 各自经过 Kiwi 持久审批门；
- 非绑定协议不会创建订单、支付或锁定库存。

## 本地校验与打包

在 Kiwi 仓库根目录运行：

```bash
npm run verify:workbuddy
npm run package:workbuddy
```

打包结果位于 `release/workbuddy/kiwi-sourcing-1.0.2.zip`。脚本只收录市场所需的元信息、
MCP 配置、图标、README 和 Skill，并在打包前执行结构、版本、工具白名单与敏感信息检查。

## WorkBuddy 预览验收

提交审核前必须在目标 WorkBuddy 5.x 客户端完成：

1. 安装 ZIP，确认 WorkBuddy 实际 Node 版本 >=22.19.0，且能够下载固定的 npm 0.12.3 包；
2. 完成 MCP `initialize` 与 `tools/list`，确认 13 个工具全部出现；
3. 真实执行 `kiwi_search → kiwi_request_quotes → kiwi_get_task`；
4. 验证 `partial_success`、空结果、断网、超时和重启恢复；
5. 验证接受协议与 handoff 分别要求明确用户确认，审批不能跨 action 复用；
6. 记录 WorkBuddy 实际 MCP `protocolVersion`，确认属于 Kiwi 支持范围；
7. 确认连接器更新、灰度、紧急下架和工具级强制确认能力。

WorkBuddy 官方要求单次调用建议在 30 秒内返回。首发一次最多询价 3 家商家；更大范围应拆成
多批，并通过 `kiwi_get_task` 汇总部分结果。
