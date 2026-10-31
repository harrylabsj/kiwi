---
name: trip-replan
description: 导入已有行程做体检（时间/路线/费用/预约/住宿/体力六域检查），或在锁定已订项的前提下做局部改程并输出差异报告。
user-invocable: false
version: 0.1.2
---

# 行程体检与局部改程 v0.1.2

## 触发

- **体检（AUDIT）**：用户贴出已有行程/攻略文本、表格或授权文件，要求"查问题、能不能走通"。
- **局部改程（REPLAN）**：计划有变化（晚点、临时想改、累了想缩短），要求只调整受影响部分。

## 体检流程

1. 先复述原计划（逐日要点），确认没有读漏，再开始指出问题——不允许读到一半就替换成新攻略。
2. 把原行程整理成 itinerary JSON（trip_request + days/slots + legs + budget），交给引擎检查。
3. 引擎会把问题分到六域：时间、路线、费用、预约、住宿、体力。逐条转述：哪个对象、什么问题、严重程度（阻断/待确认）、建议的修订方向。
4. 体检不修改原计划；修订必须走 REPLAN 生成新版本。

## 局部改程流程

1. 读取当前版本（`state show <trip_id>`），确定 expected_version；列出锁定项（已订交通、住宿、关键预约）。
2. 和用户确认三件事：变化原因、允许调整的范围（哪些 slot id）、解锁授权必须**逐项**明确——"帮我优化一下"不构成解锁全部已订内容的授权。
3. 只对范围内对象做编辑（完整替换 slot 对象），写成 edits JSON；范围外对象一个都不碰。
4. 引擎做变更校验（范围、锁定、版本）+ 全量重查 + 差异摘要（改了什么/没改什么/费用与时间变化/仍待确认）。
5. 向用户展示差异报告，等待确认后再提交新版本。

## 引擎调用

```sh
python3 <插件目录>/engine/bootstrap.py audit <itinerary.json>
python3 <插件目录>/engine/bootstrap.py replan <old.json> <change.json> <edits.json>
python3 <插件目录>/engine/bootstrap.py state show <trip_id>
```

`<插件目录>` 是本 SKILL.md 所在插件的根目录。change.json 必含：trip_id、expected_version、request_id（幂等键，一次变更唯一）、reason、scope_slot_ids、scope_lodging_ids、allow_locked_ids、user_approved、new_requirements。

## 停止与降级

- 返回 CHANGE_REJECTED（范围/锁定/版本问题）：向用户说明原因，重新确认范围后再试，禁止绕过检查。
- VERSION_CONFLICT：说明有并发修改，基于最新版本重新生成候选。
- 引擎/脚本失败：停止并上报；禁止修环境、删文件、反复重试。
- 需求本身变了（改日期、人数、预算口径）：拒绝用局部改程实现，走新请求确认流程。

## 输出与验收

差异报告四段式：改了什么（对象级）、没改什么（含全部锁定项）、为什么、费用与时间变化；最后附仍待确认清单。备选活动不自动加入主行程；激活备选必须重新核验当时预约、交通和费用。

**交付物形状（硬性）**：最终的结构化交付必须是**完整 itinerary**（含 days/slots、places、legs、budget、version+1），符合 schema/itinerary.schema.json；差异报告、change_request、说明对象只能出现在回复正文，绝不能充当最终 artifact。已知闭馆等不可用项不得保留在主计划 days/slots 中（非锁定项移除并登记待确认；锁定项保持阻断交用户决断）。
