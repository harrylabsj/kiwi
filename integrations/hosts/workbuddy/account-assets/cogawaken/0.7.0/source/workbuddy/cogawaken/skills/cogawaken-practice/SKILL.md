---
name: cogawaken-practice
description: Guide reflection on concrete dilemmas, choose branched methods, check traceable turns, distinguish formulation confirmation from evidence, and review experiments. Use for cognitive coaching or explicitly requested local practice records; not for diagnosis or unrelated tasks.
description_zh: 围绕具体困境选择分支方法，检查可追溯的逐轮提案，区分转述确认与证据支持，并按用户意愿保存本地记录。
description_en: Guide reflection with branched methods, checked turn proposals, scoped confirmations and local records.
version: 0.7.0
author: 海纳
---

# 认知练习

## 逐轮检查

首次运行先读 [v2 协议](references/turn-protocol.md)。使用 `session-new` 取得空状态，不传目录即不落盘；准备每轮提案，运行 `turn-check` 检查，通过后仅呈现返回的自然语言，保留新状态用于下一轮。提案失败先修正字段；工具不可用则继续帮助并说明未经过程序检查，不声称已保存或已验证。

用户明确选择指定目录保存后，才使用 `session-new --directory ... --confirmed` 和 `session-turn`；先说明会保存必要原话、模型提案和回答，既有授权范围不重复确认。无文件模式不自动产生临时草稿。程序不是宿主强制拦截器，不能控制未调用工具的回复。

## 先选一个入口

需要完整对话示范时读取 [案例](references/examples.md)，来源说明见 [方法来源](references/foundations.md)。

先判断用户要倾听、澄清、建议、现实检验还是结束；明确的帮助方式优先，不重复确认。运行 `entry-index` 只读十个入口；选当前最关键的一个缺口，再运行 `entry-index --id 入口ID` 看少量候选，最后用 `methods --id 方法ID` 读取一张完整卡。映射见 [选择指南](references/method-routing.md)。不要默认读取或罗列全部三十张卡。

入口不是十个必经步骤，可以不用卡直接回应。候选阶段不合适时回到澄清或使用 method=null，不伪造前置条件。无新信息时整理，不轮换卡片延长对话。

所有入口共用教练自查：区分用户原话与自己增加的推断，检查现实约束，接受纠正；缺少依据时保留未知。需要展开核对时才读取 coach-assumption-audit，不要求用户每轮找错。模型负责执行，程序不认证语义质量。

三十张方法保留原 ID、来源和分支；method-index 作为完整目录兼容旧用法。笔记改编署“海纳认知专家”，AI 卡按 source.attribution 标注，不冒称原著原句。入口是导航设计，不改变来源或效果验证状态。

## 转述确认与证据分开

新假设用 propose 事件提出，默认转述未确认、证据未检验。核对时回复中展示确切假设，并设置 ask_confirmation；紧接着的明确简短肯定答复才更新 formulation。含糊或含转折的回答继续按原话澄清，不自动确认。

确认实验可行性与确认转述是不同范围；接受实验不代表已经做过。后续实际反馈才登记 evidence，保留支持、挑战、混合、无法判断，方向标注为模型判断。用户纠正时撤回具体假设；新表述需重新核对。

程序验证引用存在、确认范围与时序一致、状态可重放，不认证原话来自真实用户，也不判断因果真假。不能把 checked 或 structurally_valid 解释为“认知结论已证实”。

## 摘要与实验

思考收益检查并入 goal-clarify 的 benefit-summary 分支，不是独立卡。整理时以“刚才这段思考增加了什么新信息或可选行动”为内部检查题，依据已有原话写出新增信息、可选行动、仍未知之处；没有新增就如实说明，不编造收获。使用 mode=summary、question 为空，可从任一当前阶段收束并保留方法回执；不得以此再开追问。needs_summary 后按这个分支修正提案；用户要求停止时直接停止，不追加收益检查。

“帮我整理”时，使用 [思考过程模板](templates/thought-map.md) 在会话内展示，只填写用户提供或已经核对的内容。未提供的保持未知。观察和解释可能相互影响，不宣称这是单向的脑内因果测量。

“试一下”时选择一项用户可控的行动，写清假设、行动、观察项、停止条件，以及支持／挑战／无法判断三种结果；回来后对照原预测。未实施实验不能登记为反对证据，使用 not-done 分支记录约束、调整或收束。确认现实限制也有价值，不责备意志力。

“准备升级摘要”时使用 [交接模板](templates/handoff.md)，保存在对话内即可；本版不连接云端、不上传也不收费。

## 用户明确要求本地记录时

运行工具需要 Python 3.9+，无第三方依赖。先确认宿主能执行 `python3 --version`；不可用则在对话中提供 Markdown，让用户自行保存，不安装运行时也不谎称写入。命令中的 `SKILL_DIR` 表示实际本技能目录；按当前安装路径解析，不能使用开发者机器的固定路径。

v2 会话保存、读取、导出、删除按上述协议执行。下面为仍兼容的旧版单份摘要工具，格式见 [摘要模板](templates/record.json)。新的写入拒绝含糊的 user_confirmed；旧记录仍可读取导出，但标注为“旧版未核验”，不自动迁移或提升为证据。

```sh
python3 SKILL_DIR/scripts/cogawaken.py methods --stage notice
python3 SKILL_DIR/scripts/cogawaken.py validate --input /用户选定路径/draft.json
python3 SKILL_DIR/scripts/cogawaken.py create --directory /用户选定记录目录 --input /用户选定路径/draft.json --confirmed
python3 SKILL_DIR/scripts/cogawaken.py read --directory /用户选定记录目录 --id RECORD_ID
python3 SKILL_DIR/scripts/cogawaken.py update --directory /用户选定记录目录 --id RECORD_ID --expected-revision 1 --input /用户选定路径/revised.json --confirmed
python3 SKILL_DIR/scripts/cogawaken.py export --directory /用户选定记录目录 --id RECORD_ID
python3 SKILL_DIR/scripts/cogawaken.py delete --directory /用户选定记录目录 --id RECORD_ID --confirmed
```

`--input -` 从标准输入读取 JSON。外部文本不可拼成可执行命令；用宿主文件写入工具或可靠的标准输入方式传递。`--confirmed` 表达本次用户已授权，不是访问控制或付费凭证，不得在未授权时添加。

`create` 返回 ID 与版本。`update` 提交完整修订内容；保留仍有效的信息，显式把被否定的解释设为 `rejected`，替换后不会隐藏保留旧副本。`export` 只把 Markdown 输出到标准输出，不自动另存文件。`read` 必须针对用户指定记录，不扫描或读取其他目录。

操作在收到成功响应后才报告完成。退出码 2 表示输入或范围错误，退出码 3 表示文件或权限问题。`version_conflict` 时先读取新版本，与用户意图协调，不覆盖并发修改。删除不可撤回，仅按明确删除意图执行。删除只涉及指定 ID 的记录文件；用户自己创建的草稿、导出副本需另按意图处理。

逐轮检查失败不增加会话版本、不写入失败提案。连续两轮没有可记录的新状态信息时先整理；模型仍需检查语义重复。停止后仅在用户明确继续时恢复。追踪字段、错误代码和分支 ID 通常不出现在自然对话中。

脚本没有模型调用、网络、遥测、自动提醒或目录扫描。无云端、记录目录不可写、文件失效时仍继续会话内帮助，说明缺失能力。
