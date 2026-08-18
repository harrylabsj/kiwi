# kiwi-buyer-openclaw

OpenClaw 原生插件：把 kiwi Buyer Core（与 `kiwi-buyer-mcp` 同一 `buildBuyerService` /
`buildKiwiTools`，9 个高层工具）以 `kiwi_buyer_*` 前缀暴露给 OpenClaw（战略 v2.5
§6.3 单核心多包装 / §6.8 三角色分离 —— Host→Kiwi Buyer，不管理商家本地运营）。

## 安装（ClawHub 一键安装）

已发布到 ClawHub：`kiwi`。

```sh
openclaw plugins install clawhub:kiwi
```

插件内置 skill `kiwi-buyer` 自动随插件加载；`@harrylabsj/kiwi` 作为运行时依赖随包安装。

## 本地开发（源码加载）

1. 在 `~/.openclaw/openclaw.json` 的 `plugins.load.paths` 加：
   ```json
   {
     "plugins": {
       "load": {
         "paths": [
           "/Users/jianghaidong/coding/kiwi/integrations/hosts/openclaw/kiwi-buyer-openclaw"
         ]
       }
     }
   }
   ```
2. 插件目录 `npm install`（拉取 `@harrylabsj/kiwi`），重启 OpenClaw（或触发插件热加载）。
   插件内置 skill `kiwi-buyer` 自动随插件加载。

## 配置（plugins.entries.kiwi-buyer-openclaw.config）

| 键 | 默认 | 说明 |
|---|---|---|
| `catalogUrl` | `https://catalog.kiwi.harrylabsj.com` | kiwi-catalog 发现入口 |
| `a2aSkipDnsCheck` | `false` | Clash fake-IP 环境需 `true`（否则 A2A 端点被 SSRF 复查误拦）|
| `dbPath` | `~/.kiwi/openclaw.sqlite` | 持久 store（task/approval/agreement）|
| `principal` | `openclaw:user` | Principal 标识 |
| `buyerAgentId` | `buyer-agent:openclaw` | buyer agent id |

## 9 个工具（§6.8 前缀 `kiwi_buyer_*`）

| 工具 | 作用 | 写/读 |
|---|---|---|
| `kiwi_buyer_search` | 发现候选供应商（catalog）| 读 |
| `kiwi_buyer_request_quotes` | 发起询价，返回稳定 task_id | 写（幂等）|
| `kiwi_buyer_get_task` | 任务状态 / 报价 / 待审批 | 读 |
| `kiwi_buyer_negotiate` | 还价 / 澄清 | 写 |
| `kiwi_buyer_accept_agreement` | 接受非绑定协议（ASK 时 approval_required）| 写 |
| `kiwi_buyer_get_agreement` | 读取协议 | 读 |
| `kiwi_buyer_handoff` | 生成 checkout / PO 路径 | 写 |
| `kiwi_buyer_approve` | 批准持久审批（用户确认后）| 写 |
| `kiwi_buyer_reject` | 拒绝持久审批 | 写 |

## 采购流

`kiwi_buyer_search` → `kiwi_buyer_request_quotes` → `kiwi_buyer_get_task` →
`kiwi_buyer_negotiate` → `kiwi_buyer_accept_agreement`（approval_required）→ 用户确认 →
`kiwi_buyer_approve` → 重试 accept → `kiwi_buyer_get_agreement` → `kiwi_buyer_handoff`。

**边界**：buyer 只经 catalog 发现、A2A 直连 merchant；**不直连 shopping-cli**（那是
服务器上 merchant 才碰的）。不处理支付（payment 恒 NEVER）。

## §6.8 隔离纪律

- 本插件只暴露 `kiwi_buyer_*`（Buyer 职责）；Merchant 运营工具在
  `kiwi-merchant-openclaw`（后续）；ReasoningBackend 在 `kiwi-reasoning-openclaw-acp`。
- Buyer token 不访问 Merchant Ops；不同插件 ID / 工具前缀 / token scope / state 目录。
