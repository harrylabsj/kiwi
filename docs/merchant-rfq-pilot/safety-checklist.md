# 安全硬门核对单（§20.2）

**频率**：每个试点商家每周核对一次 + 每次事件即时核对。任何一项触发 = 立即停止正式发布功能（`KIWI_RFQ_RELEASE=0`）并调查，调查结论与修复证据归档后才可重新打开。

| # | 硬门 | 核对方法 | 判定 | 证据归档 |
| --- | --- | --- | --- | --- |
| 1 | 未经批准的正式发布 = 0 | `rfq_quote_events` 无 APPROVED/EXPORTED 事件而候选非 executed 的记录；审计（rfq_audit_events）与命令记录（action_candidates）交叉核对 | 0 条 | 核对日期 + 查询快照 |
| 2 | 跨商家泄露 = 0 | 每条记录只有一个服务端认证归属（I01）；抽样用另一商家 token 尝试读取他方 case/quote/artifact（应 TENANT_MISMATCH/not_found）；产物下载日志全部归属一致 | 0 条 | 抽样记录 + 下载日志 |
| 3 | 虚假送达/成交/移交状态 = 0 | delivery 状态只有 REPORTED_SENT 且每条引用操作者证据；无 RECEIPT_VERIFIED 写入通道被调用；handoff 无 TARGET_VERIFIED 而无目标回执 | 0 条 | delivery/handoff 表快照 |
| 4 | 演示价用于真实报价 = 0 | 生产实例无 demo source/fake price 输入（SYNTHETIC 标记扫描）；fact_snapshots 的 source 字段不含 fake/demo | 0 条 | 快照扫描结果 |

## 伴随检查（非硬门，但异常需记录）

- 任意价格反复试探的限流与审计是否生效（拒绝日志频率异常 = 潜在底价探测）。
- 日志不含客户原文、底价、完整 token（抽查 stderr/jsonl）。
- 一次性确认凭证无复用（oauth_confirmations 已核销记录 vs approve 尝试）。
- 事实快照新鲜度告警是否被人工处理（不静默忽略）。

## 事件处置流程

1. 触发硬门 → `KIWI_RFQ_RELEASE=0` 关闭发布（保留历史只读）。
2. 保留现场：DB 备份 + 产物目录 + 审计日志。
3. 48 小时内出具调查记录：根因、影响面（波及的报价/客户）、修复方案。
4. 修复后重跑相关测试组（§19.2 审批与权限/展示与导出）+ 全量 verify，归档后由业务负责人批准重新打开。
