# Data Contract

Use CSV as the common interchange format.

## Recommended Columns

- `year`: admission year
- `province`: student/admission province
- `batch`: admission batch
- `subject_track`: 文史、理工、物理类、历史类、综合改革, etc.
- `school_code`: official院校代码
- `school_name`: 院校名称
- `major_group_code`: 院校专业组代码, if applicable
- `major_group_name`: 院校专业组名称, if applicable
- `major_code`: 专业代码, if applicable
- `major_name`: 专业名称 or专业类
- `plan_count`:招生计划数
- `min_score`: historical minimum score
- `min_rank`: historical minimum rank/位次
- `avg_score`: optional average score
- `avg_rank`: optional average rank
- `subject_requirement`:选科要求
- `tuition`:学费
- `campus`:校区
- `school_type`: 公办、民办、中外合作、独立学院, etc.
- `remarks`: official notes and restrictions
- `source`: source URL or file name

## Normalization Rules

- Store ranks as integers. Smaller rank means stronger score position.
- Remove commas and spaces from numeric fields.
- Preserve official codes as strings, including leading zeros.
- Never merge distinct major groups unless their official codes are identical.
- Keep school-level, group-level, and major-level records separate when the source provides separate granularity.

## Common Aliases

- `最低位次`, `最低排名`, `投档位次` -> `min_rank`
- `最低分`, `投档最低分` -> `min_score`
- `院校`, `学校`, `院校名称` -> `school_name`
- `专业组`, `院校专业组` -> `major_group_code`
- `选科`, `选考科目`, `科目要求` -> `subject_requirement`
- `计划`, `招生计划`, `计划数` -> `plan_count`

## Data Quality Checks

Flag records with missing school name, missing min rank, impossible year, nonnumeric score/rank, or subject requirement conflicts. Missing rank makes the record weak evidence.
