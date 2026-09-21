# merchant-management/1 —— 商家私有管理 API 契约（BD 设计 §9–§11）

管理 API major = **1**（`MANAGEMENT_API_MAJOR`）。本目录是契约权威；运行时实现
在 `src/http/merchant-management/`，共用业务层是 `src/merchant/application/`。

## 端点（均在 `/merchant/api` 下）

| 方法与路径 | 说明 |
|---|---|
| GET `/session` | 会话/主体信息 + CSRF 令牌（页面启动时取一次） |
| GET `/status` | `RuntimeStatus` |
| GET `/products?cursor&limit` | 公开商品投影分页；无商品源 → 503（不伪造空目录） |
| GET `/policy` | 规则版本与摘要（脱敏；内容不在此通道） |
| GET `/approvals?cursor&limit` | 待审批列表（脱敏投影） |
| GET `/approvals/{id}` | 确认预览（有效期、参数/前置哈希） |
| GET `/operations/{id}` | 操作回执对账 |
| POST `/confirmations` | 签发短时单次确认引用（候选审批 / `service.resume`） |
| POST `/approvals/{id}/approve` | 批准并执行（`ApprovalDecision`） |
| POST `/approvals/{id}/reject` | 拒绝并审计 |
| POST `/service/pause` | 暂停接待（拒新询价，既有任务不受影响） |
| POST `/service/resume` | 恢复接待（owner + 确认引用 + 就绪门） |

`/events`（SSE）属同 major 的可选端点，本版未提供。

## 鉴权（一个部署单元 ≠ 一个权限域）

- 会话：`kiwi_admin` cookie（与 `/admin` 同源，12h，可撤销）。未认证 → 401。
  A2A Bearer/签名、Catalog OAuth、平台 publishableKey **都不是**管理凭据。
- 写请求必须带 `X-CSRF-Token: <GET /session 返回的 csrf_token>`；请求携带
  `Origin` 头时必须精确命中实例 origin。CORS 不是认证。
- 主体只从会话派生；正文/路径/头里的 `merchant_id` / `actor_id` 一律不认（UC10）。
  跨商家对象统一 404（UC09）。
- 角色：owner（全部）/ operator（商品导入、策略草稿、审批、暂停）/ viewer（只读）。
  `service:resume`、敏感策略读取、资源删除是 owner 专属。

## 幂等（§10.2）

- 顺序：先认证与归属 → 规范化输入（未知字段拒绝）→ 权威存储查
  `(merchant_id, actor_id, command_type, idempotency_key)`。
- 同键同请求摘要 → 重放原回执（200）；同键不同摘要 → 409 conflict。
- 校验/授权类失败（未触达执行）不占幂等键——修正后可用**原键**重试；
  执行层异常且无法证明「未执行」→ 记 `unknown` 并保留 `operation_id`
  查询路径，**不能当作失败自动重做**。终态结果不可被普通重试覆盖。

## 错误码 → HTTP（§11.3；仅适用于本 API）

| code | HTTP | 说明 |
|---|---|---|
| unauthorized | 401 | 未登录/会话或主体过期 |
| forbidden | 403 | 权限不足 / CSRF 或 Origin 不符 / 确认引用无效 |
| not_found | 404 | 对象不存在**或不属本商家** |
| conflict | 409 | 幂等键冲突 / 候选状态不允许 |
| precondition_changed | 409 | 哈希/版本/有效期变化，旧确认失效 |
| invalid_input | 400/405/413 | 输入不合法 / 方法不允许 / 请求过大 |
| rate_limited | 429 | 配额/速率限制 |
| unavailable | 503 | 服务或真实数据源不可用；结果未知（附 operation_id） |
| tool_binding_unavailable | 503 | 对话绑定失败（B07 未通过时页面路径不受影响） |
| update_required | 409 | 客户端与 Runtime major 不兼容 |

## 示例

正例（审批执行）：

```http
POST /merchant/api/approvals/act_example/approve
Content-Type: application/json
X-CSRF-Token: <GET /session 取得>
```

```json
{
  "arguments_hash": "sha256:3f7a…",
  "preconditions_hash": "sha256:9c01…",
  "confirmation_ref": "（POST /confirmations 签发的一次性引用）",
  "idempotency_key": "approve-act_example-2026-09-21-1"
}
```

→ 200 `OperationReceipt`（`status: "succeeded"`，`resource_ref: "act_example"`）。

反例（都必须被拒绝）：

```json
{ "approved": true }
```
```json
{ "arguments_hash": "sha256:…", "preconditions_hash": "sha256:…",
  "confirmation_ref": "self-made", "idempotency_key": "k", "merchant_id": "merchant-002" }
```

第一个缺少确认引用与哈希；第二个含未知字段 `merchant_id`（UC10：正文不能改变
认证主体）。`expected_revision` 未纳入本版审批契约：候选对象尚无持久 revision
字段，条件更新证明由 `arguments_hash` / `preconditions_hash` 承担（BD §11.2
允许的等价机制）；service 暂停/恢复使用真实的 `expected_service_revision`。

## RuntimeManagementDescriptor

`runtime-management-descriptor.schema.json` 描述 BD §6.3 的私有只读绑定对象
（Catalog 控制面 `GET /v1/cloud-enrollments/{id}/management-descriptor` 的响应
形状，属 Catalog 侧交付）。它**不含凭据**、不能替代服务端认证、不得在公开
Agent Card 中自动出现。
