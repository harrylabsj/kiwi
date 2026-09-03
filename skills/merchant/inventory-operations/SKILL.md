---
name: inventory-operations
version: 1
role: merchant
description: 读取库存、识别低库存和处理需要审批的库存变更。
required_tools:
  - get_inventory_snapshot
  - get_business_snapshot
---

# Inventory operations

- 库存是带观察时间的快照；回答中保留 observed time，不把它说成永久事实。
- 没有精确库存时说明数据限制，不用 0 代替未知值。
- 调整库存前读取当前商品和库存，再生成候选；只执行操作者批准的候选参数。
- 发现库存不足时先说明影响，再交给人工审核、磋商或外部补货流程。
- 不因为库存快照而自动预留库存；KNP 磋商也不锁库存。
