---
name: kiwi-source-and-quote
description: Use the Kiwi connector to clarify product requirements, discover suppliers and send authorized RFQs with recoverable task IDs.
---

# 需求整理与询价

有短商品词就调用 `kiwi_search(query, category?, region?)`，发现来自 catalog 的候选。只使用结果中的真实 merchant_id，买方不直连 shopping-cli 或另建本地 marketplace。

区分硬要求与偏好：规格、数量和单位、币种、期望交期、交付地区、总预算/目标单价。缺失信息若影响询价才问，不捏造数量、预算、交期和地址。只找供应商时不发询价；用户明确要求向合适候选询价且范围足够明确时可执行，不重复索要同一授权。

## 请求构造

调用 `kiwi_request_quotes(intent, merchant_ids, idempotency_key)`：

- 始终传入非空 `merchant_ids`，从已发现且符合授权范围的候选中选择。当前实现省略该字段可能产生没有实际报价的空任务。
- `intent_id` 为本次需求的唯一标识；每项使用短 `query`，已知规格放在 `attributes` 或 `constraints.mandatory_requirements`，而不是把长规格堆进检索词。
- 已确认数量使用 `{ "value": 2, "unit": "台" }`。总预算是 `constraints.budget`，目标单价是 `constraints.target_unit_price`；金额用币种最小单位整数，例如 CNY 200 元为 20000。预算底线默认只在宿主侧用于筛选，不自动披露给商家。
- `deadline` 只使用用户给定/确认且带时区的 RFC3339 时间；不知道就省略。币种不得凭商品所在地推断。
- `context_projection.disclosure_boundary` 为 `commerce_required`，`projected_fields` 只列实际发送的采购字段；不要粘贴聊天历史。
- 相同请求因传输错误重试时保持相同的幂等键和相同载荷。需求或商家范围变化使用新键；不得用新键盲目重发状态未知的请求。
- 当前商家路由使用首个商品词检索，多个不同品类应分别发现供应商并拆成独立询价任务，不假设一个商家支持所有品类。

需要具体 JSON 结构时读取 [询价示例](references/rfq-example.json)。示例是虚构数据，必须替换为用户已授权的需求和搜索返回的 merchant_ids。

## 结果与恢复

记录返回的 `task_id`；通过 `kiwi_get_task` 查看状态、候选和错误。没有真实报价时只报告已发询价或等待结果，不能把请求预算当作报价。重连后使用已知任务 ID；用户没有提供 ID 时请其提供，当前连接器没有任务列表工具。

`partial_success` 保留成功报价并列出失败项；只在可重试且授权仍有效时单独处理失败商家。`authorization_denied` / `approval_denied` 停止，不绕过。`task_expired` 重新询价前核对需求与原授权是否仍有效。没有适配供应商时如实报告。
