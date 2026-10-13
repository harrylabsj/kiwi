---
name: merchant-trade-link-check
description: 校验商家提供的京东、淘宝或天猫商品交易链接与平台商品ID是否严格对应；适用于成交入口发布前检查，不用于联网确认商品真伪、库存或购买。
display_name: "Kiwi 三平台交易入口校验"
display_name_en: "Kiwi Marketplace Trade Link Check"
description_zh: "严格核对京东、淘宝和天猫商品入口与平台ID格式；不联网确认商品或库存。"
description_en: "Check exact JD, Taobao, and Tmall trade URL and product ID forms without claiming live product or stock verification."
category: writing
version: 0.1.0
author: harrylabsj
---

# 京东淘宝天猫交易入口校验

仅检查商家主动给出的原始链接、平台名和平台商品 ID 的结构一致性。校验结果只表示链接符合 Kiwi 接受的三平台固定形态，不表示链接可访问、商品真实、归商家所有或可购买。

## 接受形态

- 京东：平台 ID 为 ASCII 正整数字符串 N；原始 URL 必须逐字为 https://item.jd.com/N.html
- 淘宝：原始 URL 必须逐字为 https://item.taobao.com/item.htm?id=N
- 天猫：原始 URL 必须逐字为 https://detail.tmall.com/item.htm?id=N

N 必须以 1 至 9 开头，后续只能是 ASCII 数字。按文本处理，不转数值、不补零、不去前导零，也不接受科学计数、URL 编码、全角数字或被电子表格舍入后的值。

## 核对步骤

1. 要求商家提供平台、商品 ID 的原始文本值和完整原始 URL。缺任何一项就标为材料不足。
2. 检查平台是否为上述三者之一，ID 是否为正整数文本，并把原始 ID 与 URL 中解析出的 ID 逐字符比较。
3. 按对应形态检查 scheme、host、path 和 query。拒绝非 HTTPS、非规范 host、额外端口、userinfo、fragment、额外或重复 query 参数、编码变体以及多余空白。
4. 只有平台和 ID 都一致、URL 符合唯一形态时判为“格式匹配”。其他情况分别标为平台不支持、ID 无效、ID 不匹配、URL 形态错误或材料不足。
5. 如 SKU 也由商家提供，SKU 与平台 ID 分开记录。不要把 SKU 当作平台 ID。

## 输出

| 商家 SKU | 声明平台 | 声明平台 ID | URL 中的平台/ID | 判定 | 具体不符项 |
| --- | --- | --- | --- | --- | --- |

对可用入口只写“格式匹配；未验证商品真伪、页面可用性、商家归属、价格或库存”。不能声称联网已检查，也不能替商家打开平台账户、登录、下单或付款。

## 例子

输入淘宝 ID 100301440825 和原始 URL https://item.taobao.com/item.htm?id=100301440825：判为格式匹配。若同一 URL 追加 track=mail：判为 URL 形态错误；不要删掉参数后替商家输出一个看似通过的链接。
