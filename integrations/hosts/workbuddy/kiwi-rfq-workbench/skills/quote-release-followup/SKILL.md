---
name: quote-release-followup
description: 批准准备、导出与结果记录；仅用于 Kiwi 询报价私有试点。
---

# 批准准备、导出与结果记录

版本：设计 v0.1.1；状态：DRAFT_NOT_INSTALLED。依赖 tools.json 所述服务完成后才可启用。

1. 调用prepare_release取得候选和受控预览，引导用户到独立管理页确认；不要索取、打印或代填一次性批准凭证。
2. 调用get_release查询真实状态。只有服务器确认APPROVED/EXPORTED后才介绍对应正式产物；文件哈希由服务器核对。
3. 导出不等于发送。用户声明已发，只能调用record_delivery登记REPORTED_SENT，不标已送达或成交。
4. 客户表达采购意向时保存证据；prepare_handoff只准备材料。未获目标系统可信回执不得称TARGET_VERIFIED。
5. 不调用创建订单、支付、锁库存或跨轨人工处理；超时先查job/release，不盲重放。

## 输出规则

输出当前对象ID/版本、已确认事实、阻断项和下一步动作。没有工具证据就不声称执行成功。来源、内容摘要、交付状态与批准状态不得由语言模型自行改写。
