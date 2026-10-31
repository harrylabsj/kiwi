---
name: trip-intake
description: 识别 PLAN/AUDIT/REPLAN 任务、抽取旅行需求、区分硬限制偏好假设，并对缺失的关键条件做最小追问。规划、体检、改程入口前置使用。
user-invocable: false
version: 0.1.2
---

# 旅行需求与任务路由 v0.1.2

## 触发

用户开始规划、给出已有预订/攻略、或要求修改行程时，先用本技能定框架；抽取完成后再交给 trip-plan 或 trip-replan。

## 流程

1. 判断任务类型：完整规划（PLAN）、行程体检（AUDIT）、局部改程（REPLAN）。先读取同一 trip_id 的当前版本（`state show <trip_id>`，见下方引擎调用）；没有状态就新建请求，禁止套用其他旅行。
2. 从用户消息抽取：日期、当地时区（首版固定 Asia/Shanghai）、出发/返程边界、同行人数、预算口径（全程 ALL_IN / 仅当地 DESTINATION_ONLY）、每日与连续步行上限、兴趣、明确排除项、已订项目（机酒/门票/预约）。
3. 已有订单只提取必要字段；证件号、订单码当场舍弃不入文。用户说"已订"记 USER_REPORTED，取得供应商确认前不升级为已核实。
4. 缺失信息分两类：**阻断项**（会改变安全、预算、返程或预约可行性）必须追问，一次最多三个问题；**可标注假设**（口味、节奏）先给方向性草案，不追问。
5. 产出结构化需求（trip_request 字段：trip_id、origin、destination、start_date、end_date、party_size、budget_cap_fen、budget_scope、max_daily_walk_m、max_continuous_walk_m、interests、hard_exclusions、assumptions、consent_to_store）。

## 引擎调用

本技能一般不需要跑引擎；如需确认已有旅行状态，用 Bash（路径相对于本文件所在的插件目录）：

```sh
python3 <插件目录>/engine/bootstrap.py state show <trip_id>
```

`<插件目录>` 是本 SKILL.md 所在插件的根目录（本文件位于 `<插件目录>/skills/trip-intake/SKILL.md`）。

## 停止与降级

- 用户连目的地都未定时：给少量方向比较，明确标注"未核验"，不假装已完成核验。
- 引擎脚本失败：原样停止并上报错误文本，禁止自行修环境、删文件或重试安装。
- 用户拒绝存储（consent_to_store=false）：仍可规划，但不落盘保存版本。

## 输出与验收

输出：任务类型判定 + 结构化需求字段清单 + 已标注假设 + 需要用户确认的问题（≤3 个）。所有数值保留用户原表述单位，金额换算为分（元×100）再进入引擎。
