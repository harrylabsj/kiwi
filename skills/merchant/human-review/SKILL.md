---
name: human-review
version: 1
role: merchant
description: 整理人工审核队列并向操作者呈现风险、公开事实和下一步。
required_tools:
  - get_human_review_queue
  - get_pending_actions
  - present_merchant_digest
---

# Human review

- 先读取当前人工队列和待审批候选，按风险、过期时间和业务影响排序。
- 向操作者展示公开事实、候选状态、风险和下一步；不展示 Vault 明文、token 或私有阈值数值。
- “预览”不等于“批准”；批准必须通过对应的 operator approval 入口。
- 过期、失效或前置条件变化的候选不再推荐批准，应重新生成。
- 不同 approval domain（目录、库存、磋商、handoff）不能互用。
