# Kiwi

**A2A 电商磋商协议 + 独立运行时（KNP/1.0）**。Buyer 与 Merchant 作为独立 A2A Agent，通过
[A2A](https://a2a-protocol.org/) 与 [UCP](https://ucp.dev/) 完成发现 → capability 协商 →
磋商 → 非绑定协议。磋商以**非约束性商业协议**终止：不创建订单、不支付、不锁库存。

**Kiwi A2A v0.6.0 已发布（2026-08-07）**：基线 §41 完成定义 27/27 经就绪度审计实证满足
（见 [`docs/kiwi-a2a-v1.0-readiness-audit-2026-08-06.md`](docs/kiwi-a2a-v1.0-readiness-audit-2026-08-06.md)）。

## 协议：KNP/1.0

- 公开稳定 namespace：`com.harrylabsj.kiwi.shopping.negotiation`
- spec：<https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0>
- schema：<https://kiwi.harrylabsj.com/schemas/negotiation/1.0/schema.json>
- 完整规范：[`docs/protocol/kiwi-negotiation-protocol-1.0.md`](docs/protocol/kiwi-negotiation-protocol-1.0.md)
- 架构基线：[`docs/kiwi-a2a-architecture-baseline.md`](docs/kiwi-a2a-architecture-baseline.md)

KNP/1.0 九类核心对象（Inquiry / RFQ / Offer / CounterOffer / ConditionalOffer / Clarification /
AcceptNonbinding / Withdraw/Decline/Cancel / AcceptedNonbindingAgreement）已冻结为 JSON Schema，
与领域实现交叉一致性对齐（`contracts/negotiation/1.0/schema.json`）。

## 架构

```
Buyer Agent ──A2A wire──▶ Merchant Agent
   │                          │
   ├─ Agent Card / UCP Profile │
   ├─ capability intersection  │
   ├─ Negotiation Envelope     │   （KNP/1.0 对象，JCS 规范化 digest）
   ├─ Ledger（append-only）    │
   ├─ Idempotency / Recovery   │
   ├─ ConditionalOffer 求值    │
   └─ 非绑定协议                └─ 交易 handoff（agreement→checkout，operator 授权）
```

- **谈判领域**：Envelope + 九类对象、条件确定性求值、Ledger（hash 链）、幂等、跨进程恢复、remote/local 对账。
- **原生 A2A**：Agent Card、A2A client/server、Channel 抽象（direct / hosted）、Task 生命周期、消息签名。
- **UCP 互操作**：profile 模型/resolver、capability intersection、well-known 服务。
- **开放网络**：trust records、fan-out 隐私 + 多商家 RFQ、服务端限流。
- **交易 handoff**：agreement→checkout 桥、operator 门控授权、只读 order records。

## 边界与安全

- 磋商只形成**非约束性共识**（§41 #25/#26/#27）：不创建订单、不支付、不锁库存。
- Principal Memory 不进入远程上下文；Remote Content 不会直接成为 Principal Memory。
- Remote Agent 不能获得任意本地工具能力；所有写入经策略门 + 审批。
- 磋商期间不持久化模型 thinking；凭据按 scope 隔离，模型只见工具、永不见 token。

## 快速开始

```bash
npm install
npm run build
npm test              # 1236 tests（75 文件），零外部依赖
npm run verify        # lint + typecheck + build + test + package smoke
```

CLI 概览：

```bash
kiwi                                     # 一个入口：`kiwi>` 自由对话 + 自动启动 A2A 节点
kiwi chat --profile <file>               # 指定 profile 的主对话 + Principal Memory
kiwi doctor --profile <file>             # 只读诊断
kiwi agent run --profile <file>          # 单 agent 前台磋商
kiwi agent serve --profile <merchant> --catalog <url> [--no-chat]
                                         # 无头 merchant A2A server（自动注册；缺省也开对话）
kiwi tui --profile <file>                # 操作者驾驶舱（supervised/manual/autopilot）
kiwi init/up/status/logs/down --dir <d>  # managed-local 产品栈生命周期
```

`kiwi`（裸）进入后：

- **自由聊天**：deepseek 等真实模型（`KIWI_MODEL*` 可配置）
- **自动 A2A 节点**：按角色监听（merchant:9000 / buyer:9001，占用自动换；`KIWI_A2A_PORT` 覆盖），`--no-a2a` 关闭
- **merchant 角色自动注册**进 kiwi-catalog（buyer 据此发现）
- 命令：`/profile <buyer|merchant|file>` 切换角色（A2A 节点同步重建）、`/a2a` 看节点状态、`/discover` 列出 catalog agents、`/negotiate <id>` 与某个 agent 磋商、`/register` 手动注册、`/quit` 退出

双实例相互发现：

```bash
# 终端 A（merchant）
kiwi
kiwi> /profile merchant.deepseek     # → [a2a] merchant@9000 registered cagt_...

# 终端 B（buyer）
kiwi
kiwi> /profile buyer.deepseek        # → [a2a] buyer@9001
kiwi> /discover                      # 看到 merchant
kiwi> /negotiate cagt_...            # 磋商 → agreement（无副作用）
```

> 注册域名默认 `merchant-<agent_id>.local`，可用 `KIWI_CATALOG_DOMAIN` 覆盖；catalog 地址默认 `http://127.0.0.1:8600`（`KIWI_CATALOG_URL` 覆盖）。

### 真实商品闭环（shopping-cli 开放商品层）

merchant 的 A2A 报价**读真实商品源**（缺省 shopping-cli 的 `/products/{sku}` 公开端点），
shopping-cli 自身可接本地 ERP / 商品表：

```bash
# merchant 指向真实 shopping-cli（缺省用 profile.commerce.base_url）
KIWI_COMMERCE_URL=http://127.0.0.1:63161 kiwi agent serve --profile merchant.deepseek.yaml --port 9000
```

`/negotiate` 报告即显示数据库真实价（如 `商家首次报价：99.00 元/件`）；商品源不可用时
回退演示价并在回复中注明（`商品源不可用（<sku>），使用演示价`）。

裸 `kiwi` 的默认底层大模型**可配置**（不 hardcode，从环境变量读）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `KIWI_MODEL_PROVIDER` | `deepseek` | 模型 provider（pi-ai 目录） |
| `KIWI_MODEL` | `deepseek-v4-flash` | 模型 id |
| `KIWI_MODEL_API_KEY_ENV` | `DEEPSEEK_API_KEY` | 持有 API key 的环境变量名 |
| `KIWI_MODEL_BASE_URL` | 缺省 | 可选 OpenAI 兼容端点覆盖 |

对话内可用 `/profile <file.yaml>` 切换为任意 buyer/merchant profile（换模型/角色/记忆）。

本地双 agent 实测（两个独立进程，经 kiwi-catalog 发现 + A2A 自由对话）：

```bash
node scripts/a2a-agent.mjs --role merchant --port 9000   # 独立 merchant A2A server
node scripts/a2a-agent.mjs --role buyer                   # 交互式 buyer（缺省角色）
# buyer 命令：inquiry | rfq | counter | accept | clarify | withdraw | decline | quit
```

> `model.provider: fake` 使用内置确定性模型，无需任何凭据即可本地冒烟 / CI。

## 测试与质量

```bash
npm run lint            # eslint --max-warnings=0
npm run typecheck       # tsc --noEmit（strict）
npm run test            # vitest，1236 tests
npm run verify          # 全部 + 生产包冒烟
```

覆盖：协议对象/schema 与领域交叉一致性、原生 A2A client/server、UCP 发现与 intersection、
谈判域（幂等/恢复/条件求值）、interop 端到端（双边 / 跨 channel / fan-out / 恢复 / **网络分区** /
未信任内容 / 签名身份）、operator 授权、Principal Memory、安全边界。

## 文档

- [`docs/kiwi-a2a-architecture-baseline.md`](docs/kiwi-a2a-architecture-baseline.md) — 架构基线（§41 完成定义）
- [`docs/protocol/kiwi-negotiation-protocol-1.0.md`](docs/protocol/kiwi-negotiation-protocol-1.0.md) — KNP/1.0 规范
- [`docs/kiwi-a2a-v1.0-readiness-audit-2026-08-06.md`](docs/kiwi-a2a-v1.0-readiness-audit-2026-08-06.md) — v1.0 就绪度审计
- [`CHANGELOG.md`](CHANGELOG.md) — 版本历史

## 许可

[Apache License 2.0](LICENSE)（协议 spec/schema 公开托管于 `harrylabsj/kiwi-spec`，同样 Apache-2.0）。
