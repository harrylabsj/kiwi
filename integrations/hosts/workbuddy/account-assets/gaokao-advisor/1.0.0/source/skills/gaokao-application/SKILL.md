---
name: gaokao-application
description: 用于高考志愿填报顾问，依据省份规则、位次、选科、官方历史录取数据和个人偏好，生成谨慎、可解释、可核验的志愿草案；不保证录取。
metadata: {"version":"1.0.0","display_name":"高考志愿填报工作流","tags":["gaokao","college-application","china-admissions","高考","志愿填报"]}
---

# 高考志愿填报工作流

为中国大陆高考志愿填报提供资料整理、候选筛选、风险分档和核验清单能力。

## 先决原则

- 位次是主要匹配依据，分数只辅助解释。
- 每次确认省份、年份、批次、科类或选科及投档模式；不得跨省套规则。
- 不把历史最低位次当成未来确定线。须说明招生计划、专业冷热、专业组设置、政策和同分人数的影响。
- 当年招生计划、代码、选科要求、学费、校区和限制条件必须以官方资料为准。
- 不保证录取，不输出“必中”“稳上”“包录”等结论。

## 执行流程

1. 收集考生画像：省份、年份、批次、科类或选科、分数、位次、填报模式、偏好、预算和不能接受项。
2. 读取 `../../references/province-rules.md`、`../../references/workflow.md`，确认省份规则和缺失信息。
3. 有数据时读取 `../../references/data-contract.md`，先执行数据质量检查，再按条件筛选候选。
4. 需要时使用根目录 `../../scripts/` 下的 `validate_dataset.py`、`normalize_admission_data.py`、`shortlist_builder.py`、`risk_scoring.py` 和 `rank_matcher.py`；它们的计算结果只作为辅助证据。
5. 依据 `../../references/risk-policy.md` 区分冲、稳、保、垫，并同时标注资格核验和跨年口径风险。
6. 依照 `../../references/output-templates.md` 输出候选表、排序草案和提交前核验清单。
7. 使用 `../../references/source-checklist.md` 为当年信息指定官方核验来源。

## 数据不足时

只给资料收集方案：请用户补充官方一分一段表、往年录取数据、当年招生计划或具体候选。不得虚构当年线、代码或计划。

## 脱敏与边界

不需要、也不请求身份证号、准考证号、填报账号或密码。对特殊类型招生、体检、单科、语种、性别、政审和定向协议的限制，提示用户按官方章程核验。
