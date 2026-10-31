# Risk Policy

Use rank gaps as a starting point, then adjust for volatility and constraints.

Let:

```text
rank_gap = historical_min_rank - student_rank
gap_ratio = rank_gap / student_rank
```

Because smaller rank is better, a positive gap means the student's rank is stronger than the historical minimum rank.

## Default Bands

- 冲: `gap_ratio < -0.05` or recent rank is stronger than the student, only suitable for a small number of aspirational choices.
- 小冲: `-0.05 <= gap_ratio < 0.03`
- 稳: `0.03 <= gap_ratio < 0.15`
- 保: `0.15 <= gap_ratio < 0.35`
- 垫: `gap_ratio >= 0.35`

These are defaults, not universal rules. Tighten them when the dataset is thin, the major is热门, plan count shrank, or rules changed.

## Risk Modifiers

Increase risk when:

- only one year of data is available
- plan count decreased
- professional group changed
- major became热门
- record is school-level but user cares about a specific major
- subject requirements changed
- tuition/campus/special restriction is unclear
- group contains many unwanted majors and user may be调剂

Decrease risk when:

- three or more years show stable rank range
- plan count is stable or increased
- the user accepts group-level调剂
- the option is less demand-sensitive and constraints are clear

## Language

Use cautious language:

- Good: `相对稳妥`, `有一定冲刺风险`, `需要核验计划变化`, `不建议作为唯一保底`.
- Bad: `稳上`, `必中`, `包录`, `绝对安全`.
