---
name: assess-evidence
display_name: 工作评价证据分析
display_name_en: Work Feedback Evidence Assessment
description: Assess evidence about work feedback, distinguishing records, user reports, hypotheses and uncertainty without personality scores.
description_zh: "当用户问上级怎么看自己的工作、是否不信任自己时，区分记录、转述、行为信号与假设，给出有限结论与求证动作，不输出人格或好感评分。"
description_en: Assess evidence about work feedback, distinguishing records, user reports, hypotheses and uncertainty without personality scores.
version: 0.1.3
author: 北京海纳福星文化传媒有限公司
user-invocable: false
---
# 工作评价证据分析
当用户问“上级怎么看我的工作、是不是不信任我、是不是要换掉我”时使用。

依据与边界见 @references/research-notes.md、@references/safety-boundaries.md；输出证据卡时按 @templates/evidence-card.md。

## 方法
把“发生了什么”“用户感受到什么”“用户据此解释什么”分开。对材料记录来源、时间、上下文完整性与事件标识。
按交付质量、可靠性、独立判断、协作沟通、发展支持五个工作目录组织信息。这不是心理测量量表，不输出总分。
每个重要判断写明：有限结论、范围、支持材料、反向材料、信息缺口。没有反向材料写“尚未提供”，不能写成“不存在”。
明确引用上级一句批评，可以判断该次反馈表达了什么；不能断定上级整体否定用户、隐藏嫉妒或即将裁员。
新增任务、回复变慢、检查变多等行为仅是待解释信号；核对项目环境、团队是否统一变化、资源与权限是否匹配。
模糊材料至多保留三个有依据解释，每个给出区分问题和可推翻条件。明确威胁、羞辱或骚扰不要求生成善意解释。

## 输出
先给能确认和不能确认的核心判断，再给具体反馈问题，例如：“这次方案哪一部分已达到要求，下一版最应改哪里？”
需要时展开五维证据卡；不因用户反复追问同一材料提高结论强度。用户转述须持续标“据你描述”。

## 禁止
好感度/信任分数/裁员概率；人格诊断；从性别年龄地域推断动机；把用户的担心写成事实；用单次项目评价推断人的整体价值。
