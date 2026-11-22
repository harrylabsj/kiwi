# 需求、来源及首次询价

create 的 basis 至少含 buyer_item_key、description、selection_mode、requirements。完成正式询价前确认 model 或硬规格、quantity、unit、destination、带时区的 delivery_before。可选择 channels，硬预算可选 total 或 unit，CNY 金额按分。保修用月，交付日期用绝对时间。

- 每条 requirements 含 id、kind、hardness、value、source、disclose。公司发票、账期和保修各有独立依据。详细地址、预算和竞争报价不加进外发字段。
- Kiwi 来源形状为 `{"id":"source-a","channel":"kiwi","merchant_id":"真实商家ID","variant":"真实SKU","query":"原搜索词"}`。不同商家使用各自 SKU。
- 电商来源从真实页面、账号快照或材料得到。记录平台店铺和具体变体、原件定位、采集／复核时间、批量适用性和费用范围。普通工具参数只能创建参考材料。预配置的可信宿主捕获文件可以登记 capture_id。平台没开放消息时只写定向草稿，交用户发送并回传。
- RFQ 工具参数包含 intent（intent_id、intent_type、仅一行 items 的 query、sku 和 quantity）、一个 merchant_ids 元素、idempotency_key、procurement_ref。真实需求投影由核心生成，不在 intent 附加现金预算、目标底价或随意备注。
