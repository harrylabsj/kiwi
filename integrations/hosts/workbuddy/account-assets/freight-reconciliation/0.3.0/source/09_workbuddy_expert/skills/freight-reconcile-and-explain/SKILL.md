---
name: freight-reconcile-and-explain
version: 0.2.0
author: Haina
description: Start deterministic runs, poll jobs and explain evidence-backed differences.
---
# 运行与差异解释

## 前置
映射、费率已确认（管理页状态为 CONFIRMED）；必要的人工关联已确认。未确认就运行 → 规则层返回 RULE_UNCONFIRMED / RATE_NOT_FOUND，如实转述。

## 流程

1. **启动运行**：`freight_start_run(case_id)` → 立即返回 job_id（导入与重算都是长任务，
   30 秒响应约束下不允许同步等待，§18.2）。
2. **轮询**：`freight_get_job(job_id)`，QUEUED/RUNNING 期间不要反复启动新 run；
   终态 SUCCEEDED / PARTIAL / FAILED。PARTIAL 表示有限范围完成但仍有失败项，如实呈现。
   FAILED 时把 error.code/message/recovery_action 转述给用户。
3. **汇总**：`freight_get_summary(run_id)` 展示：
   - 账单净额 = 可比 + 不可比 + 明确排除（守恒）；
   - 正向/反向/净差额；金额覆盖（分母=全部账单行绝对值）；
   - amount_complete=false 时必须提示"不能正式冻结"。
4. **差异清单**：`freight_list_issues(run_id, code?, cursor?, limit?)` 分页读取；
   cursor 失效（查询参数变化）时重新查询，不要把截断当完整。
5. **解释**：`freight_get_evidence(run_id, group_id)` 四栏核对——原账单定位、运输/凭证、
   规则与公式轨迹、当前决定。逐项说清"依据哪次运输、哪版规则、哪些证明"。
6. **待人工关联**：`freight_list_match_candidates(case_id)` 列出 AMBIGUOUS/UNMATCHED 行；
   P3 候选只是建议——把候选与依据展示给用户，用户决定后用
   `freight_prepare_match(case_id, bill_line_id, trip_id)` 生成确认候选（管理页确认）。
   不以"分数最高"代替人工确认。

## 边界
- 不重写金额公式，不叠加同组价差与疑似重复金额（组差额只计一次）。
- NOT_BILLED_IN_PROVIDED_SCOPE 是提醒不是节省；缺证金额单列，不混入差额。
- 展示时带 run_id、版本、覆盖率分母与未解决项数量。
