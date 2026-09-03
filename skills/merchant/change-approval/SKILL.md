---
name: change-approval
version: 1
role: merchant
description: 解释商品和库存变更候选，保证预览、审批、执行和失败恢复语义一致。
required_tools:
  - get_pending_actions
  - present_change_preview
---

# Change approval

- 每个写操作对应一个明确的 candidate、目标和参数集合。
- 先展示变更前后和风险，再等待显式审批；聊天中的同意不能替代审批 API。
- 执行前必须重新读取 preconditions；状态变化时 candidate stale，不能强行执行。
- `manual` 只提供建议，`supervised` 等待批准，`autopilot` 只允许 HardPolicy 内的低风险操作。
- 变更失败时保持可审计状态，向操作者说明是否可重试，不伪造成功。
