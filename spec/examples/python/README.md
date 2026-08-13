# kiwi-ref (Python) — KNP 最小独立参考实现

Kiwi Negotiation Protocol (KNP) 的**独立 Python 参考实现**（Issue 11 / D2）。
**零 Kiwi runtime 依赖、零第三方依赖**（纯 Python 标准库），与 Kiwi TS 实现逐字节
互操作：RFC 8785 JCS digest / envelope 结构 / A2A 1.0 JSON-RPC 帧。

「独立」= 不 import Kiwi runtime，按公开协议（`spec/schemas/negotiation/1.0/schema.json`
+ `docs/protocol/kiwi-negotiation-protocol-1.0.md`）从零实现。证明开放互操作
（不是 Kiwi 与自己互通）。

## 能力

- 读 Agent Card（`GET /.well-known/agent-card.json`）
- A2A 1.0 SendMessage（`A2A-Version` + `A2A-Extensions` 头 + KNP DataPart）
- 买家：RFQ → Offer → CounterOffer → ConditionalOffer → 求值 → Accept →
  non-binding Agreement
- 商家：完整相位机（RFQ→offer→counter→conditional→accept→agreement，
  非法转换 / 终态重开 / terms_digest 不匹配一律 fail-closed decline）
- KTH Handoff：达成 Agreement 后构造 HandoffCandidate（`creates_order` /
  `authorizes_payment` / `reserves_inventory` 恒 `false`，不真交易）
- 可校验 transcript：JSONL + JCS 内容寻址 + `previous_event_digest` 哈希链，
  `verify` 检出篡改 / 断链 / 重复 / 损坏

## 运行

```sh
# 商家（常驻）
python3 -m kiwi_ref merchant --port 8123

# 买家（对任意 A2A merchant 跑完整流程 + 输出 transcript）
python3 -m kiwi_ref buyer --url http://127.0.0.1:8123 --jsonl out.jsonl

# 校验 transcript 哈希链
python3 -m kiwi_ref verify --jsonl out.jsonl
```

## 测试（零依赖 unittest）

```sh
cd spec/examples/python
python3 -m unittest discover -s tests -t . -v
```

测试锚定 Kiwi TS 生成的 golden digest（`contracts/interop/knp-data-part-examples.json`
+ `tests/knp-conformance-vectors.test.ts`）：本实现重算 digest 必须逐字节一致。

## 模块

| 模块 | 职责 |
| --- | --- |
| `kiwi_ref/jcs.py` | RFC 8785 JCS + `sha256:` content digest |
| `kiwi_ref/envelope.py` | KNP envelope 构造 / digest / 校验（fail-closed） |
| `kiwi_ref/a2a.py` | A2A 1.0 JSON-RPC client（SendMessage / card / 提取） |
| `kiwi_ref/conditional.py` | ConditionalOffer 求值器（all/any/leaf） |
| `kiwi_ref/merchant.py` | 最小 A2A merchant（相位机 + HTTP 层） |
| `kiwi_ref/transcript.py` | 可校验 JSONL transcript（哈希链） |
| `kiwi_ref/handoff.py` | KTH HandoffCandidate（三副作用恒 false） |
| `kiwi_ref/run.py` | CLI（merchant / buyer / verify） |

## Wire 契约（互操作要点）

- **请求**：`POST <a2aPath>`，头 `A2A-Version: 1.0`、`A2A-Extensions: <origin>/a2a/extensions/negotiation/1.0`、
  body `{jsonrpc, id, method: "SendMessage", params: {message: {role, messageId, parts: [{text}, {data: {knp_envelope}, mediaType: "application/json"}]}}}`。
- **响应**：`result.task.status.message.parts[].data.knp_envelope` 携带回复 envelope
  （即使 1.0 请求，响应 parts 仍是 0.3 形状 `{kind:"data", data:{...}}`）；
  agreement 在 `task.artifacts[].parts[].data.agreement`；状态 `TASK_STATE_*`。
- **envelope digest**：`sha256:` + `sha256(JCS(envelope 去掉 digest + signature 字段))`
  （KNP §19.2）；`terms_digest` = `contentDigest(求值后的 agreed terms)`（§19.3）。
- JCS：键排序、字符串转义不含 U+2028/U+2029 与非 ASCII、数字最短往返 + 指数规范化。
