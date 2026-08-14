# KNP/1.0 Spec Convergence（2026-08-13）

> 本文把 KNP/1.0 开放互操作所需的规范收敛为一份可独立实施的文档（Issue 12）。
> 它是协议正文 `docs/protocol/kiwi-negotiation-protocol-1.0.md` 的**收敛补充**：
> 已覆盖的章节直接引用，未覆盖或近期实证才改变的（A2A 1.0 carrier mapping /
> 扩展激活细节 / 并发报价 / 差异矩阵 / 边界 / conformance vectors）在此给出具体内容。
>
> 公开镜像：carrier mapping → `spec/a2a/extensions/negotiation/1.0-carrier-mapping`；
> conformance vectors → `spec/conformance/knp-1.0-vectors.json`；
> 第三方参考实现 → `spec/examples/python/`（零 kiwi 依赖，纯标准库）。

## 1. A2A 1.0 Carrier Mapping（KNP 载荷在 1.0 DataPart 上的承载）

KNP/1.0 在 A2A 1.0 上由 **JSON-RPC `SendMessage` + KNP DataPart** 承载（协议正文 §24）。
以下 wire 形状已由 Issue 10 官方 TCK/SDK 往返与 Issue 11 三向互操作逐字节实证。

### 1.1 请求

```
POST <a2aPath>                          # 缺省 "/"；Agent Card supportedInterfaces[0].url
A2A-Version: 1.0
A2A-Extensions: <origin>/a2a/extensions/negotiation/1.0
Content-Type: application/json

{ "jsonrpc": "2.0",
  "id": "<opaque>",
  "method": "SendMessage",
  "params": {
    "message": {
      "role": "user",                    # 也接受 "ROLE_USER"（proto 枚举名）
      "messageId": "<= envelope.message_id>",
      "parts": [
        { "text": "人类可读文本（可选）" },
        { "data": { "knp_envelope": { "…envelope…" } },
          "mediaType": "application/json" }
      ]
    }
  }
}
```

要点：
- `messageId` **必须等于** KNP envelope 的 `message_id`。
- KNP DataPart 是 1.0 统一 Part：判别靠字段存在（无 `kind`），`data.knp_envelope`
  + `mediaType: "application/json"`（`KNP_DATA_MEDIA_TYPE`）。
- 可选 `params.contextId`、`message.taskId` / `message.contextId`（会话延续）。

### 1.2 响应

```
{ "jsonrpc": "2.0",
  "id": "<echo of request id>",
  "result": { "task": {
      "id": "task_…",
      "contextId": "ctx_…",
      "status": {
        "state": "TASK_STATE_WORKING",   # 1.0 wire：proto 枚举名
        "message": {
          "role": "ROLE_AGENT",
          "messageId": "<商家回复 envelope.message_id>",
          "parts": [ { "data": { "knp_envelope": { "…" } }, "mediaType": "application/json" } ]
        }
      }
    } } }
```

要点：
- 回复 envelope 在 `task.status.message.parts[].data.knp_envelope`。
- 1.0 响应使用统一 Part（`{data:{...}, mediaType:"application/json"}`）；0.3
  compatibility adapter 单独保留 `{kind:"data", data:{...}}`。解析器同时接受两种
  版本形状，但不会把 legacy carrier 泄漏到 1.0 响应。
- 任务终态（decline / agreement）：`state` = `TASK_STATE_COMPLETED`。
- Agreement artifact 在 `task.artifacts[].parts[].data.agreement`。
- 商业拒绝在 `task.status.message.parts[].data` = `{decline: true, reason_code, message}`。

### 1.3 1.0 错误体

1.0 错误帧 `error.data` 是 **`google.rpc.ErrorInfo` 数组**：

```
"error": { "code": -32600,
  "message": "…",
  "data": [ { "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              "domain": "a2a-protocol.org",
              "reason": "…" } ] }
```

错误码映射（A2A 1.0）：TaskNotFound `-32001`、TaskNotCancelable `-32002`、
PushNotificationNotSupported `-32003`、UnsupportedOperation `-32004`、
ContentTypeNotSupported `-32005`、VersionNotSupported `-32009`。

### 1.4 版本 / 状态 wire 值

1.0 wire 用 **protobuf 枚举名**：`ROLE_USER` / `ROLE_AGENT`（也接受小写）、
`TASK_STATE_SUBMITTED|WORKING|INPUT_REQUIRED|COMPLETED|CANCELED|FAILED|REJECTED|AUTH_REQUIRED`。

## 2. 扩展 URI、版本规则、激活

- **扩展 URI**：`/a2a/extensions/negotiation/1.0`（相对路径常数
  `KNP_EXTENSION_PATH`）；`A2A-Extensions` 头发**绝对 URI** `<origin>/a2a/extensions/negotiation/1.0`。
- **capability**：`com.harrylabsj.kiwi.shopping.negotiation`；
  `protocol_version` 常量 `"1.0"`（正文 §4.4）。
- **激活**：client 在 1.0 模式每请求带 `A2A-Version` + `A2A-Extensions`。
  server 读 `A2A-Extensions`，与 card `capabilities.extensions` 对齐。
- **fail-closed**：未知扩展 → JSON-RPC `-32600`（`invalid request`）；未声明
  `streaming` / `pushNotifications` 的 capability 被请求 → `-32004` / `-32003`。
  server 对非 `application/json` 的 `Content-Type` 在 HTTP 层 `415` 拒绝。

## 3. 通用（非 KNP）消息语义

无 `knp_envelope` 的普通 A2A 消息**不进入磋商管线**：server 完成 task +
生成 `contextId` + 回显 parts 为 artifact（注入式 `genericResponder`，产品缺省
回显；TCK 参考场景在 conformance 层）。taskId 语义校验（TaskNotFound /
终态→UnsupportedOperation / contextId mismatch）**只对通用消息生效**——KNP
磋商会话由 `(sender_identity, message_id)` 幂等驱动，跨回合复用终态 taskId 是
既有设计（interop 双边流实证）。

## 4. 状态转换（含并发报价规则）

正文 §21.2 定义核心转换表。补充**并发报价规则**：

- 每个 `negotiation_id` 同时至多一个 `active_offer_id`（最近一次 offer 类出站）。
- 商家接受 `accept_nonbinding` 时校验 `payload.offer_id` === 已发出的 conditional
  `offer_id`（不符 → `offer_unknown` decline）。因此两个并发报价中只有被接受的那
  个能产生 agreement——按 offer_id 隔离，不按轮次。
- 终态（AGREEMENT_REACHED / WITHDRAWN / DECLINED / CANCELED）后任何商业动作
  → `state_conflict` decline。

## 5. 幂等 / 重放 / 过期 / 撤回 / transcript

正文 §19–§20、§22、§28 已定义；收敛要点：

- 幂等键 `(sender_identity, message_id)`，24h floor（§20.1）；handoff 幂等键
  `(source_candidate_id, source_candidate_digest)`，≥7 天（KTH rev0.3 §5）。
- 报价有效期 `valid_until`：accept 时校验，过期 → `offer_expired`（正文 §11/§15）。
- 撤回 `withdraw` scope=offer/negotiation（§17.2）；negotiation 级进入终态。
- transcript 完整性：协商 + handoff 事件走同一内容寻址 + 哈希链（`event_digest`
  = sha256 over JCS(业务字段)，`previous_event_digest` 连接）。第三方校验可复现
  `sha256:` + RFC 8785 JCS（§19.1/19.2）。

## 6. 差异矩阵：vs UCP negotiation、Concordia

| 维度 | KNP/1.0 | UCP A2A negotiation | Concordia（A2A 社区提案 #1725） |
| --- | --- | --- | --- |
| 定位 | 商业专用 RFQ→Agreement（非绑定、可审计） | A2A 通用 negotiation binding | 去中心化磋商通用协议 |
| 绑定性 | 显式 `binding_effect: nonbinding`；三副作用恒 false | 未定义商业绑定语义 | 通用，不定义商业约束 |
| 证据 | `accepted_nonbinding_agreement` artifact + 哈希链 transcript | 未定义 agreement artifact | 未定义 |
| 审批 | `human-required` / 审批边界（§22） | 未定义 | 未定义 |
| 成交入口 | KTH HandoffCandidate（destination_type 词表单一来源） | 未定义 | 未定义 |
| 独立实现 | `spec/examples/python/` 零依赖参考实现 + conformance vectors | 依赖 A2A SDK | 依赖社区实现 |
| 实时事实 | ConditionalOffer 条件 field 词表（aggregate.* / fulfillment.* / …） | 未定义 | 未定义 |

**结论**：KNP 不为"A2A 有磋商"而存在（UCP/Concordia 已覆盖通用磋商）；KNP 的价值是
**跨商家、多属性、可审计、默认非绑定、带审批与 Handoff 的商业磋商规范**。

## 7. 协议边界：KNP / KTH / UCP / AP2 / ACP-Commerce

分层（战略基线 §4，公开时保持）：

- **A2A 1.0**：发现、传输、任务生命周期、版本与扩展协商。
- **KNP**：RFQ、Offer、CounterOffer、Clarification、非绑定 Agreement、审批边界。
- **KTH**：非绑定 Agreement 如何交接给外部执行系统（HandoffCandidate → destination）。
- **UCP**：可承载商品/购物车/checkout 的商业执行能力。
- **AP2**：意图与支付授权的可验证 mandate，**不是** checkout 本身。
- **ACP-Commerce**：未来/实验性商业协议适配方向。
- **Merchant Checkout / ERP / PO**：最终执行目的地，由商家拥有。

这些不是同一层可互换的名称。文档、网站、演示必须保持该分层。

## 8. Conformance vectors（第三方最小可独立实现）

- **发布文件**：`spec/conformance/knp-1.0-vectors.json`——5 个完整 envelope
  （counter_offer / offer / inquiry / accept_nonbinding / task_result）+ 内置期望
  digest。第三方实现重算 `sha256:` + JCS 并与期望值逐字节比对即可自证。
- **golden digest 锚点**（`tests/knp-conformance-vectors.test.ts`）：
  counter_offer `sha256:87517fc5…`、offer `sha256:99dfb819…`、
  inquiry `sha256:a0853976…`、accept_nonbinding `sha256:0231490e…`。
- **参考实现**：`spec/examples/python/`（Issue 11）——零依赖 Python，JCS/envelope/
  A2A client/merchant/transcript/handoff 全实现，39 unittest 对上述向量逐字节一致。
- **三向互操作**：`npm run conformance:three-way`——Independent↔Kiwi↔Independent
  全部 RFQ→Agreement→Handoff 跑通（21 passed）。

## 复现

```sh
npm run build
node scripts/conformance/three-way-interop.mjs
cd spec/examples/python && python3 -m unittest discover -s tests -t .
```
