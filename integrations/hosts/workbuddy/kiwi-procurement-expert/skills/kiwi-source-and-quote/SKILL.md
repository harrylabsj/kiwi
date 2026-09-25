---
name: kiwi-source-and-quote
description: Use the Kiwi connector to clarify product requirements, discover suppliers and send authorized RFQs with recoverable task IDs.
---

# 需求整理与询价

有短商品词就调用 `kiwi_search(query, category?, region?)`，发现 Kiwi Network 内的候选；本会话若提供互联网检索/网页读取工具，同轮再查一路外部电商商品，两路结果**分区展示**（见「双来源结果」）。只使用结果中的真实 merchant_id，买方不直连 shopping-cli 或另建本地 marketplace。

## 搜索结果的两类商家

`kiwi_search` 结果可能同时包含两类商家，展示时必须区分：

- **可实时询价**（`inquiry_available=true`）：有可路由 Agent 的第 1 版商家，是 `kiwi_request_quotes` 的唯一合法对象。
- `inquiry_available=false` 的商家不可发起 RFQ：`资料可查`（仅第 0 版公开资料，从未开通实时询价）
  与 `服务当前不在线`（开通过但心跳超时，`merchant_offline`）是两种情况，措辞不要混用；
  离线是暂时的，可建议稍后重试，不要说成「未开通」或「已下架」。
- **资料可查**（`inquiry_available=false`、`source_kind="merchant_declared"`）：仅有第 0 版公开资料的商家。其 `publications` 含命中商品名（`title`）、商家声明来源、更新时间（`updated_at`/`published_at`）和可选公开店铺入口（`shop_url`）。可以向用户展示这些信息并建议买家自行到原店铺查看，但：
  - 不得把这些商家放进 `merchant_ids` 发起询价——服务层会拒绝并报 `merchant_inquiry_unavailable`（该商家目前仅公开资料，尚未开通 Kiwi 实时询价），不会产生任务；
  - 不得声称已取得其库存、报价或已向其发出 RFQ；公开资料是商家声明内容，不是 Kiwi 背书，也不是实时数据；
  - 同一商家同时有两版资料时只显示一个主体，说明实时询价能力来自其 Agent 侧，公开资料并列展示。

结果带 `note` 时如实转述（如某数据来源暂不可用）；没有任何结果时也必须区分原因——只有 `network_search` 为 `completed` + `no_match` 才说「本次没有匹配」，其余情况说明查询未完成或覆盖不完整（见下），不凭记忆或常识补出商家。

## 双来源结果

采购搜索覆盖两个来源，分别展示、分别标注出处，不混成一张列表：

| 来源 | 展示名称 | 谁提供 |
|---|---|---|
| Kiwi Network | Kiwi Network · 网络内商家 | `kiwi_search`（只覆盖这一路） |
| 互联网电商 | 互联网电商 · 平台商品 | 本会话的互联网检索/网页读取工具；没有就如实说明未检索互联网，不得宣称已双来源 |

用户限定来源（「只看 Kiwi Network」）时只查该来源，不暗示另一路查过。每个来源默认先展示最多 3 条最相关结果，条目按以下模板给出：

- 商品名称；商家或店铺名称（未知就说明未知）；
- 关键规格与与需求的差异（缺失项明确标出）；
- 价格：标明类型与适用单位——页面参考价 `page_reference`、商家资料价 `merchant_listed_price`、商家报价 `merchant_quoted`、待询价 `to_be_quoted`；
- 起订量、库存与交期、税费与运费：只有真实字段才填值，未知标「待确认」，不按零计算；
- 来源依据：外部结果给平台名与原始链接（未读取原页面不得标为已核实）；Network 结果给可追溯的商品资料（`products[].listing_id`）；
- 信息时间：区分「本次查询时间」与「资料更新时间」，两者都不代表实时库存。

`network_search` 状态决定结论怎么写：

| status / result_state | 写法 |
|---|---|
| `completed` + `no_match` | 「本次没有匹配」（Network 覆盖完整） |
| `completed` + `has_candidates` | 展示候选，不声称已满足全部硬性条件 |
| `partial`（含 `undetermined`） | 展示已取到的结果，明确说明覆盖不完整 |
| `timeout` / `error` | 说明本次暂时查不到 → 先展示互联网一路，不得写成「没有供应商」 |
| `not_searched` | 说明该来源未执行（用户限定或能力不可用），不得写成没有匹配 |

外部候选是只读信息：不得放进 `kiwi_request_quotes` 的 `merchant_ids`，不得当作 Kiwi Network 商家，也不适用 Kiwi 协议与交接状态；需要时提供原始链接或拟好的询价内容。

区分硬要求与偏好：规格、数量和单位、币种、期望交期、交付地区、总预算/目标单价。缺失信息若影响询价才问，不捏造数量、预算、交期和地址。只找供应商时不发询价；用户明确要求向合适候选询价且范围足够明确时可执行，不重复索要同一授权。

## 关注商家与公开动态

买家可以显式关注商家、主动查看其公开动态（拉取式订阅）：

- 只有买家**明确要求**“关注这个商家”时才调用 `kiwi_follow_merchant(merchant_id, category?, consent_version?)`；搜索、浏览公开资料、发起询价都不构成订阅，不得因这些行为替买家关注。可选 `category` 用于只关心某类目动态。
- 买家问“我关注的商家有什么更新”时用 `kiwi_get_follow_updates`：返回按商家分组的公开事件（`product_added` / `product_updated` / `faq_updated` / `service_notice` / `publication_withdrawn`，只有公开字段），增量返回、看过后不重复。这些是商家发布的公开动态，不是实时库存/报价，也不是商家发给买家的消息——商家没有向关注者推送的通道。
- 买家要求取消时用 `kiwi_unfollow_merchant`；买家想管理关注对象时用 `kiwi_list_follows` 展示当前活跃关注。取消后不再向买家展示该商家的更新。
- 工具返回“需要先在 Kiwi 目录登录”或“会话已过期”时，如实转告买家并引导其完成 Kiwi 目录登录后重试；不得绕过、不得伪造买家身份。

## 请求构造

调用 `kiwi_request_quotes(intent, merchant_ids, idempotency_key)`：

- 始终传入非空 `merchant_ids`，从已发现、符合授权范围且 `inquiry_available=true` 的候选中选择。当前实现省略该字段可能产生没有实际报价的空任务。
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
