# 开放询价中继（transport-only）契约

> 状态：**显式例外（rev1.3 补充）**。基线（`docs/kiwi-a2a-architecture-baseline-rev1.3.md`
> §商户接入）规定商家把公开元数据发布到 kiwi-catalog、与买家 Agent **直连**磋商。
> 为支持「买家无需账号」的询价，kiwi-catalog 在商家显式授权后提供一条**报文中继**：
> 它把买家签名的 A2A 请求原样转发到商家 `/a2a`。本文固定这条通路的边界与不变量，
> 避免实现漂移或把它误读成「目录参与磋商」。

## 1. 一句话定义

**目录是传输中继，不是磋商参与方**：它转发已签名的字节，不解析条款、不生成或修改报价、
不裁决结果、不保存磋商状态；它持有并代填商家分享码，因此**能看到报文明文**。

与「不参与磋商」的关系要分开说：

| 口径 | 是否成立 | 说明 |
| --- | --- | --- |
| 不裁决、不改条款、不生成报价 | ✅ | 无任何 terms 解析或改写逻辑 |
| 不保存磋商状态 | ✅ | 响应以 `no-store` 返回；目录不建 task/协商表 |
| 不在报文链路上 | ❌ | `message/send`、`SendMessage`、`GetTask`、`ListTasks`、`CancelTask`、`tasks/get` 都经目录转发 |
| 对内容保密 | ❌ | 报文（含询价与报价）对目录可见，只是目录不落库、不记日志正文 |

对外表述请使用「目录不裁决、不存储」，不要使用「目录看不到磋商内容」。

## 2. 端点与授权链

| 端点 | 用途 |
| --- | --- |
| `GET /v1/agents/{id}/public-inquiry` | 可用性探测：仅在授权 + 绑定 + 代管 + 发布全部有效时返回 `{available, catalog_agent_id}`，否则 404 |
| `POST /v1/agents/{id}/public-inquiry` | 签名中继：原始 body ≤ 64 KiB，逐字节转发到当前活动绑定的 `<runtime_origin>/a2a` |
| `PUT/GET /v1/agents/{id}/public-inquiry-consent` | 商家（owner + 绑定私钥签名）单独的开放询价授权，`terms_version = open-inquiry-v1`，可随时撤销 |

授权与既有「分享码代管」授权相互独立：没有开放询价授权时，中继对任何人都返回 404。
每次请求都重新校验授权（撤销、重新绑定、绑定过期、代管关闭、access 配置失效、
名片未处于 `ACTIVE` 任一不满足即 fail-closed），不使用缓存的「已授权」结论。

## 3. 不变量（改动即视为协议变更）

1. **方法白名单**：只接受 `SendMessage` / `GetTask` / `ListTasks` / `CancelTask` /
   `message/send` / `tasks/get`；其他方法 400，不外发。
2. **头白名单**：只转发 `content-type` / `content-digest` / `signature` /
   `signature-input` / `a2a-version` / `a2a-extensions`；重复头直接 400。
3. **必须带签名头**：缺 `content-type`/`content-digest`/`signature`/`signature-input`
   一律 400——中继不替买家签名，也不接受未签名请求。
4. **目标不可由调用方选择**：目标来自绑定表，且必须等于 `runtime_origin.rstrip("/") + "/a2a"`；
   不接受调用方提供的 URL。
5. **分享码不出服务端**：分享码由服务端在转发时拼接；响应体若出现分享码（原样或
   URL 编码形式）一律转为固定 502，且日志只记自有错误码、净化后的标识与异常类型。
6. **响应白名单**：上游响应只允许 `jsonrpc` / `id` / `result` / `error` 四个顶层键，
   `id` 必须与请求一致，`result` 与 `error` 恰有其一；否则固定 502。
7. **不落库、不缓存**：成功响应以 `Cache-Control: no-store` 返回；目录不写 task/协商状态，
   也不保存请求或响应正文。
8. **限流**：按客户端 IP 30 次/分钟（与公开读共用桶但独立前缀）；客户端自报 IP 不能选桶。
9. **上游出站**：https-only、pinned DNS/TLS、禁止重定向、body ≤ 64 KiB、15 s 超时，
   复用 `ProfileFetcher.post_signed_a2a` 的 SSRF 策略。

上述 1–9 由 `kiwi-catalog` 的 `tests/test_public_inquiry_{relay_hardening,transport,consent}.py`
与 kiwi 的 `tests/three-party-open-inquiry.e2e.test.ts` 覆盖；改动任一条需要同 PR 更新本文与测试。

## 4. 信任假设与残余风险

- **内容可见性**：目录可读到询价、报价与 task 状态。对目录运营方而言不是机密；
  商家与买家不应把仅限双方可见的信息放进报文。
- **凭据集中**：目录持有商家分享码并代填。目录数据库泄露等于该绑定被接管；
  缓解手段是绑定可撤销、分享码可轮换，以及授权逐次校验。
- **可用性耦合**：目录不可用时开放询价整体不可用（直连买家不受影响）。
- **匿名开放面**：任何匿名来源都能发起询价（受 30/min/IP 约束）。商家侧以
  `kiwi-inquiry-session-v1:<pk>` 会话签名身份 + nonce 防重放限定任务可见性，
  不依赖来源 IP，因此目录同源转发不会造成跨买家任务串号。

## 5. 变更门槛

以下任一改动必须先改本文、再改实现，并在 PR 描述中标注「开放询价契约变更」：

- 方法白名单、头白名单、响应白名单；
- 目标来源（绑定表 → 调用方提供）或分享码注入方式；
- 授权语义、`terms_version`、撤销/失效判定；
- 限流口径或「不落库」承诺。

`terms_version` 目前保持 `open-inquiry-v1`：本次只补充说明文字，不改变授权语义，
因此不要求已授权商家重新授权；若将来收紧授权范围或改变可见性，必须升版本并要求重新授权。
