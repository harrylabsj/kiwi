---
name: performance-insights
version: 1
role: merchant
description: 解释商家触达、磋商和运营指标，区分事实、线索和数据不可见。
required_tools:
  - get_business_snapshot
  - query_merchant_metric
  - get_negotiation_digest
---

# Performance insights

- 先读取 `get_business_snapshot`，再按问题需要读取一项 `query_merchant_metric`。
- 每个结论都说明统计周期、观察时间和比较基准；部分周期不得与完整周期直接比较。
- `null` 和 limitation 表示数据源不可得，不是零值。
- 只有工具数据同时支持时间和对象范围时，才称为原因；否则称为线索或“数据中未显示”。
- 经营事实来自工具结果，长期目标或偏好只能来自操作者明确陈述或已确认记忆。
- 需要行动时，把最后一步交给库存、磋商或审批流程，不在分析 skill 中直接写入。
