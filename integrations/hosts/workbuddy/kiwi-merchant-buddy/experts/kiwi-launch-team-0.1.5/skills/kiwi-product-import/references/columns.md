# Kiwi 商品导入列定义（与当前 main 源码核对）

本参考根据当前 main 的 src/cloud/product-import-tabular.ts（字段及模板顺序）整理。生成 CSV 时使用中文/字段双写列名：

    商品编号/sku,名称/title,币种/currency,计价单位/unit,单价/price,起订量/moq,库存/stock,供货说明/supply_note,更新时间/updated_at,有效期至/valid_until,状态/status,交易平台/trade_platform,平台商品ID/platform_product_id

## 字段约束

| 字段 | 必填 | 规则 |
|---|---|---|
| sku | 是 | 非空文本；同一导入表内唯一。 |
| title | 是 | 非空文本。 |
| currency | 是 | 可识别的三字母币种代码或服务端支持的常见中文币种名；不猜货币符号。 |
| unit | 是 | 明确的计价单位文本，如件、箱、kg；不根据标题推测。 |
| price | 是 | 有限非负数，按元填写并可无损表示到两位小数。0 合法，不能因零值本身拒绝；超过精度或不能无损转换时请商家提供精确值，不自行四舍五入。 |
| moq | 否 | 若填写，必须为正整数。 |
| stock | 否 | 若填写，必须为非负整数。留空表示没有库存事实，不代表零；不确定时留空。 |
| supply_note | 否 | 公开供货说明文本。不要放成本、底价、私有供应条件或秘密。 |
| updated_at | 否 | 若填写，使用可识别日期或 ISO 时间。留空时导入器写入导入时刻；该值不是原商品更新时间，也不能当成来源观察时间。缺少此可选列不等于平台拒绝。 |
| valid_until | 是 | 可解析的有效截止日期；不得用默认期限或当前时间补齐。 |
| status | 否 | 可识别的在售/暂停状态；留空时导入器默认 active。 |
| trade_platform | 否，成对 | 仅 jd、taobao、tmall 及其支持别名。平台与 platform_product_id 必须同时填写或同时留空。 |
| platform_product_id | 否，成对 | 必须为文本单元格，值为 ASCII 正整数字符串，首位为 1–9、其余为 0–9；不接受数字单元格、公式、URL、前导零、全角数字、空格或科学计数。不要转成 Number，以免长 ID 失真。 |

Kiwi 根据平台和原始文本 ID 固定生成商品页，不接收任意商家 URL：

- jd：https://item.jd.com/{id}.html
- taobao：https://item.taobao.com/item.htm?id={id}
- tmall：https://detail.tmall.com/item.htm?id={id}

不要手工拼 URL，也不要声称导入校验能证明商品真伪、页面可访问、商家所有权或实时库存。

## 关键校验与风险

- 必填字段缺失、价格为空/负数/非有限/无法无损表示到分、日期无效、币种不识别、无效 MOQ/库存、SKU 重复或平台字段不成对，都会成为行级错误。
- 价格 0 在 schema 上合法，不因零本身阻断；商家可确认其是否为有意售价。
- 平台 ID 必须是文本而不是 Excel 数字或公式。极长 ID 一旦经过数值单元格转换可能丢失原始数字，不要尝试恢复或猜位数。
- 有效期 valid_until 是必填；updated_at、stock、moq、supply_note、status、trade_platform 和 platform_product_id 是可选，但平台字段必须成对。
- 疑似底价、成本、进价等私密价格策略列会导致导入整表拒绝；移除这些私有列，不改名后保留。

## 导入语义

导入是整表替换。提交目录未包含的 SKU 可能被下架；只改部分商品时，仍要包含所有希望继续在售的商品。上传及最终确认由商家本人完成。数据行最多 5000、列最多 64、文件最多 4 MiB、单元格最多 2000 字符；超限应先分批并说明整表语义。
