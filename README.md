# Kiwi

**A2A 电商磋商协议 + 独立运行时（KNP/1.0）**。Buyer 与 Merchant 作为独立 A2A Agent，通过
[A2A](https://a2a-protocol.org/) 与 [UCP](https://ucp.dev/) 完成发现 → capability 协商 →
磋商 → 非绑定协议。磋商以**非约束性商业协议**终止：不创建订单、不支付、不锁库存。

**Kiwi 当前代码版本 0.7.22**：当前发布线包含 A2A 双栈、KNP/1.0 磋商、签名身份
与安全交接能力。A2A 1.0 线协议互操作以组合 conformance transcript 为准，不用历史审计
文档替代运行证据。

## 协议：KNP/1.0

- 公开稳定 namespace：`com.harrylabsj.kiwi.shopping.negotiation`
- spec：<https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0>
- schema：<https://kiwi.harrylabsj.com/schemas/negotiation/1.0/schema.json>
- 完整规范：[`docs/protocol/kiwi-negotiation-protocol-1.0-rev1.4.md`](docs/protocol/kiwi-negotiation-protocol-1.0-rev1.4.md)
- 架构基线：[`docs/kiwi-a2a-architecture-baseline-rev1.3.md`](docs/kiwi-a2a-architecture-baseline-rev1.3.md)

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
npm test              # 全部离线测试，零外部依赖
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
kiwi demo [a|b]                         # 启动真实 kiwi-catalog + 3 个本地 merchant 的确定性演示
```

`kiwi demo` 需要可运行的 `kiwi-catalog` checkout（默认查找 `../kiwi-catalog`，也可用
`KIWI_CATALOG_DIR` 指定）及其 Python 环境；演示只使用 loopback、临时 SQLite 和
非绑定 Handoff，不执行订单、支付或库存写入。

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
>
> **公网 merchant**：A2A 节点默认监听回环并广告回环地址（仅本机可达）。要让
> 外部 buyer 经 DNS + 反向代理（Caddy/Nginx）发现并直连，用
> `KIWI_A2A_PUBLIC_URL=https://<domain>`（如 `https://merchant.example.com`）覆盖——
> 节点仍绑定 `127.0.0.1:<port>`，但 Agent Card / UCP / catalog 注册都广告该
> 公网 HTTPS 地址，注册域名缺省取 `<domain>`（`KIWI_CATALOG_DOMAIN` 仍优先）。
>
> **⚠️ 公网形态的认证前置条件**：广告地址非 loopback 时，节点
> **启动即失败**，除非显式配置入站认证验证器（`startA2aNode({authVerifier})`
> 或 `A2AServer` 的等价接线）。原因：缺省 `LoopbackOnlyAuthVerifier` 只信任
> socket 来源——反向代理从 `127.0.0.1` 连接节点，外部请求在应用层看起来就是
> loopback 并被认证通过，"仅本机可访问"的安全边界在公网形态下失效。
>
> 公网部署必须二选一：
> 1. **HTTP Message Signature 验证器**（推荐）：`HttpMessageSignatureVerifier`
>    校验 RFC 9421 签名 + content-digest（带 body 的请求强制绑定请求体），
>    对端须持有本节点信任的签名密钥；
> 2. **明确、可审计的代理认证契约**：如反代层完成 TLS 客户端证书或等价强认证，
>    并把验证结果以节点可审计的方式透传——不得只信任 `remoteAddress`。
>
> 本地形态（不设 `KIWI_A2A_PUBLIC_URL`）不受影响，维持 loopback 默认值。
>
> `KIWI_A2A_AUTH` env 提供三种内置模式：`loopback`（**仅限本地开发 /
> 代理即边界**——节点只校验 socket 来源，经反代转发的公网流量在应用层
> 全部是 loopback 被放行，等价无应用层认证；公网广告地址 + loopback
> 启动时会输出醒目 stderr 警告）、`none`（显式可信网络/测试）、
> `bearer:<token>`（校验 `Authorization: Bearer <token>`，**公网节点
> 推荐**）。

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

### Merchant Experience（0.8 升级能力）

Merchant profile 可选择开启基于 `commerce-agents` 设计借鉴的运营能力层：经营摘要、A2A
磋商摘要、待审批操作、只读 grounding、外部数据 fencing、host presentation event 和
Merchant HTTP/SSE adapter。
该能力层不改变 KNP/A2A wire，也不绕过现有 `WriteApprovalCandidate`、HardPolicy 和
审批流程。

这里的 HardPolicy 是 profile 私有阈值、`clampHintsToHardPolicy()` 与写入/磋商 gates
的组合设计概念，不是独立导出的类型。

```yaml
merchant_experience:
  enabled: true
  intelligence: true
  grounding: true
  presentation: true
  skills: true
  prompt_cache_retention: short
```

`enabled` 缺省为关闭，以保持旧 profile 的工具面兼容；安全 fencing 是全局行为，会改变
外部工具结果的模型可见包装，但不改变工具名称、参数和写入语义。`skills: true` 时会从发布包中的
`skills/merchant/` 加载版本化 `SKILL.md`，并挂载 `load_skill`；Skill 只提供流程原则，
不能改变权限或审批规则。Host 若要接收结构化展示和 grounding 事件，可通过
`buildChatKernel(profile, dataDir, catalog, eventSink)` 注入 `AgentEventSink`；没有 sink
时不会挂载 presentation 工具，也不会产生 `text_delta`/`ui_partial` 流事件，但只读 Merchant
能力和现有 TUI 行为不受影响。使用 `eventSink` 时，`text_delta`、工具生命周期、
`ui_partial` 和审批 `candidate_update` 均来自 AgentHarness 正式事件接口。外部 Host
可使用 createMerchantHttpServer() 接入独立 session、SSE 事件流和 candidate 审批。新
能力的实现边界和工具清单见 [`docs/merchant-experience.md`](docs/merchant-experience.md)。

## 测试与质量

```bash
npm run lint            # eslint --max-warnings=0
npm run typecheck       # tsc --noEmit（strict）
npm run test            # vitest（全离线）
npm run verify          # 全部 + 生产包冒烟
```

覆盖：协议对象/schema 与领域交叉一致性、原生 A2A client/server、UCP 发现与 intersection、
谈判域（幂等/恢复/条件求值）、interop 端到端（双边 / 跨 channel / fan-out / 恢复 / **网络分区** /
未信任内容 / 签名身份）、operator 授权、Principal Memory、安全边界。

## 文档

- [`docs/kiwi-a2a-architecture-baseline-rev1.3.md`](docs/kiwi-a2a-architecture-baseline-rev1.3.md) — 架构基线（§41 完成定义）
- [`docs/merchant-experience.md`](docs/merchant-experience.md) — Merchant Experience、Skills、Grounding、Fencing 与 Host Event
- [`docs/protocol/kiwi-negotiation-protocol-1.0-rev1.4.md`](docs/protocol/kiwi-negotiation-protocol-1.0-rev1.4.md) — KNP/1.0 规范
- [`docs/protocol/knp-spec-convergence-2026-08-13.md`](docs/protocol/knp-spec-convergence-2026-08-13.md) — KNP/1.0 实施收敛说明
- [`docs/reviews/a2a-sdk-conformance-transcript.jsonl`](docs/reviews/a2a-sdk-conformance-transcript.jsonl) — A2A SDK 往返实证记录
- [`skills/kiwi-buyer/SKILL.md`](skills/kiwi-buyer/SKILL.md) — Hermes Buyer 公共 skill
- [`CHANGELOG.md`](CHANGELOG.md) — 版本历史

## 反馈与支持

请先确认你使用的 Kiwi、`shopping-cli`、`kiwi-catalog` 版本，再选择最接近的入口：

- [报告 Bug](https://github.com/harrylabsj/kiwi/issues/new?template=bug_report.yml) — 请附最小复现、版本和环境。
- [集成 / 采用反馈](https://github.com/harrylabsj/kiwi/issues/new?template=integration_feedback.yml) — 记录安装、Agent Card、发现、RFQ、报价或 handoff 哪一步遇到问题。
- [使用咨询](https://github.com/harrylabsj/kiwi/issues/new?template=usage_question.yml) — 不确定怎么配置或调用时使用。
- [功能建议](https://github.com/harrylabsj/kiwi/issues/new?template=feature_request.yml) — 说明要解决的用户或协议问题，不要只提交实现方案。

提交公开 Issue 前，请移除 token、密钥、Authorization header、私有域名或 IP、文件路径、客户资料和生产端点。
`kiwi doctor` 是只读诊断工具；如附上输出，请先人工检查并脱敏。安全漏洞不要发公开 Issue，按
[`SECURITY.md`](SECURITY.md) 的私密渠道报告。

## 许可

[Apache License 2.0](LICENSE)（协议 spec/schema 公开托管于 `harrylabsj/kiwi-spec`，同样 Apache-2.0）。
