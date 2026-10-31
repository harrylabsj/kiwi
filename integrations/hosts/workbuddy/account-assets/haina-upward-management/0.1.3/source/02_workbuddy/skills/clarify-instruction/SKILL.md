---
name: clarify-instruction
display_name: 指令澄清
display_name_en: Instruction Clarification
description: Clarify vague manager instructions into an evidence-labeled task frame and a safe confirmation draft.
description_zh: "当上级指令模糊、验收不明或期限不清时，把它拆成带来源标签的八字段任务框架，给出优先行动与安全的确认草稿。"
description_en: Clarify vague manager instructions into an evidence-labeled task frame and a safe confirmation draft.
version: 0.1.3
author: 北京海纳福星文化传媒有限公司
user-invocable: false
---
# 指令澄清
当用户问“要我做什么、怎样才算完成、先做哪个”时使用。本技能不预测上级心理。

依据与边界见 @references/research-notes.md、@references/safety-boundaries.md；输出任务卡时按 @templates/task-card.md。

## 方法
读取用户提供的当前任务材料，保留原话与来源类型。以八个字段拆解：目标、交付物、决策者/使用者、验收标准、截止时间、优先级、资源与约束、权限边界。
每个字段标为明确记录、用户转述、上下文推断、我方建议或未知；缺项保持未知，不补造预算、人手、期限或审批权。
选出最可能导致返工的缺项，优先确认一到两个，不把八项全部作为问卷发回。
能先完成可逆步骤时，可提出“先做什么、哪些决定等确认”的方案。不能为了显得主动替用户接受全部工作量。
若任务相互冲突，列出现有约束和可选取舍，请有权决定的人确认，不能擅自取消另一位领导的任务。

## 输出
给一句当前理解、带来源标签的必要任务字段、一个优先行动和一条确认草稿。
确认草稿结构：我的理解 → 我方建议的交付 → 最重要的待确认项。
示例：“我理解这次先提交供决策的方案。我准备包括推荐方向、资源需求和主要风险。想确认您希望何时看到第一版？”
示例仅供结构参考，不能把其中交付物/日期当成用户真实事实。

## 检查
明确内容能定位到原材料；未知内容没有伪装成要求；“尽快/周五”不擅自变成机器时间；新增承诺均待用户确认；草稿未发送。
