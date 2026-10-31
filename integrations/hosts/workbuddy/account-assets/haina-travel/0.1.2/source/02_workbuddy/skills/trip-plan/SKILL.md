---
name: trip-plan
description: 已订机酒或已选景点的两日以上行程，编排吃住玩衔接的每日计划并跑结构化检查，输出三层交付。
user-invocable: false
version: 0.1.2
---

# 行程编排与检查 v0.1.2

## 触发

用户要求生成完整计划：机酒已订帮我排顺、已有景点清单帮我排日程、或 trip-intake 抽取完成后的 PLAN 任务。

## 流程

1. 从 trip-intake 的结构化需求出发；先落**固定项**：已订交通（到达/返程）、已订住宿（入住/退房日期、房间数）、已约门票/餐厅（具体日期与时段，USER_REPORTED 与 CONFIRMED 分开标）。
2. 每天选一个主题区域；选点给"看什么、为什么适合、建议停留多久、预约和步行代价"；每顿重点餐最多一主选一备选，每个住宿片区少量候选——这是控制决策负担的默认，不是旅游规律。
3. 把结果写成 **blueprint JSON**（结构见下），再交引擎装配与检查。你负责选点与体验描述；时间计算、交通衔接、预算、检查由引擎完成。
4. 引擎返回后：按 report 如实交付；CHECKED_PLANNING 才能说"检查范围内通过"；CONDITIONAL 必须列出待确认清单；BLOCKED 必须说明不可行点。不许把引擎没给的通过自己补上。

## blueprint 结构（写给引擎的输入）

```json
{
  "data_origin": "SYNTHETIC 或 LIVE",
  "theme": "主题一句话",
  "request": { ...trip_request 全字段... },
  "areas": {"0": "第一天的区域", "1": "第二天的区域"},
  "anchors": [
    {"kind": "ARRIVAL|DEPARTURE|ATTRACTION|LODGING", "day_index": 0,
     "place": {"name": "...", "category": "...", "city": "...", "address": "...", "origin": "..."},
     "start": "...ISO8601带时区", "end": "...",
     "open_from": "...", "open_until": "...",
     "reservation_status": "NOT_REQUIRED|USER_REPORTED|CONFIRMED",
     "check_in": "YYYY-MM-DD", "check_out": "YYYY-MM-DD", "rooms": 1, "capacity_per_room": 2,
     "booking_status": "USER_REPORTED|CONFIRMED", "hints": {"另一地点名": {"transit_min_low": 8, "transit_min_high": 15, "walk_m": 350, "mode": "WALK"}}}
  ],
  "candidates": [
    {"name": "...", "category": "ATTRACTION|RESTAURANT|HOTEL|TRANSPORT|OTHER",
     "kind": "ATTRACTION|MEAL", "area": "...", "city": "...", "address": "...",
     "duration_min": 90, "priority": "MUST|PREFERRED|OPTIONAL",
     "open_from": "09:00", "open_until": "17:00", "open_verified": true,
     "indoor_walk_m": 600, "reservation_status": "NOT_REQUIRED",
     "rationale": "为什么适合", "highlight": "体验亮点",
     "hints": {"另一地点名": {"transit_min_low": 8, "transit_min_high": 15, "walk_m": 350, "mode": "WALK"}}}
  ],
  "budget_items": [
    {"id": "cost-room", "category": "INTERCITY|LODGING|MEALS|LOCAL_TRANSPORT|TICKETS|RESERVE",
     "unit": "PERSON|PARTY|ROOM_NIGHT", "unit_low_fen": 50000, "unit_high_fen": 60000,
     "quantity": 1, "status": "ESTIMATE|QUOTE|PAID_USER_REPORTED", "notes": "口径说明"}
  ]
}
```

注意：hints 是两地点间**保守交通估计**（分钟区间+步行米数），没有依据的地点对不要编——引擎会诚实标"待核查"。地图真实路线由引擎的 LIVE 提供方（高德）取得，不由你拼凑。

## 引擎调用

```sh
python3 <插件目录>/engine/bootstrap.py plan <blueprint.json>          # 快照/离线模式
python3 <插件目录>/engine/bootstrap.py plan <blueprint.json> --provider live   # 已配置高德 KEY 时
python3 <插件目录>/engine/bootstrap.py export <plan.json> --out <交付目录>
```

`<插件目录>` 是本 SKILL.md 所在插件的根目录。plan 输出是 JSON（plan/report/meta）；把 report 的 decision 与 issues 如实转述给用户。

## 停止与降级

- 引擎返回 BLOCKED：如实交付不可行点与已可行部分，不重试到"看起来通过"。
- 引擎/脚本失败：停止并上报错误文本。脚本纪律是零删除、零改名；禁止自行修环境（重建 venv、重装依赖）或反复重试。
- 超过 40 次外部调用预算（LIVE 模式）引擎会自动停止：交付已取得成果与缺失清单。

## 输出与验收

三层交付（导出器生成 overview/daily/manual 三个 markdown）：一页总览（状态头、主题、预算区间、三处最值得期待、必须先做的动作）、每日卡片、完整手册（含核验说明与事实标签）。你在其上补充体验描述，但不得改动引擎给出的时间、金额、状态与事实标签。
