# Kiwi 采购询价 WorkBuddy Connector

该目录是提交到 WorkBuddy 连接器市场的完整源包。首版采用 WorkBuddy 托管 Node 22 运行时，
通过 `npx` 启动固定版本 `@harrylabsj/kiwi@0.8.0` 的 stdio MCP Server。

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
- npm 包固定为正式发布的 `0.8.0`，不使用 `latest`；
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

打包结果位于 `release/workbuddy/kiwi-sourcing-1.0.0.zip`。脚本只收录市场所需的元信息、
MCP 配置、图标、README 和 Skill，并在打包前执行结构、版本、工具白名单与敏感信息检查。

## WorkBuddy 预览验收

提交审核前必须在目标 WorkBuddy 5.x 客户端完成：

1. 安装 ZIP，确认 Node 22 能下载并启动固定 npm 包；
2. 完成 MCP `initialize` 与 `tools/list`，确认 9 个工具全部出现；
3. 真实执行 `kiwi_search → kiwi_request_quotes → kiwi_get_task`；
4. 验证 `partial_success`、空结果、断网、超时和重启恢复；
5. 验证接受协议与 handoff 分别要求明确用户确认，审批不能跨 action 复用；
6. 记录 WorkBuddy 实际 MCP `protocolVersion`，确认属于 Kiwi 支持范围；
7. 确认连接器更新、灰度、紧急下架和工具级强制确认能力。

WorkBuddy 官方要求单次调用建议在 30 秒内返回。首发一次最多询价 3 家商家；更大范围应拆成
多批，并通过 `kiwi_get_task` 汇总部分结果。
