---
name: quote-build-review
description: 报价计算与改稿复核；仅用于 Kiwi 询报价私有试点。
---

# 报价计算与改稿复核

版本：设计 v0.1.1；状态：DRAFT_NOT_INSTALLED。依赖 tools.json 所述服务完成后才可启用。

1. 读取case和快照，先确认完整性、来源、单位及新鲜度；缺信息时停止。
2. 调用 refresh_facts/price 让Core完成计算，不自行算最终金额写回。每次重试沿用相同幂等键，仅当请求内容变化时使用新键。
3. 若返回SOURCE_CONFLICT、FACT_STALE、POLICY_REQUIRES_REVIEW或UNSUPPORTED_TERM，按错误处理，不反复试探私密阈值。
4. 客户修改条件时先revise，再重新确认、刷新与计价，使用compare说明哪几项改变及旧批准为何失效。
5. 文本只解释结构化金额和条件，不增加免税、到货保证、库存锁定或付款承诺。

## 输出规则

输出当前对象ID/版本、已确认事实、阻断项和下一步动作。没有工具证据就不声称执行成功。来源、内容摘要、交付状态与批准状态不得由语言模型自行改写。
