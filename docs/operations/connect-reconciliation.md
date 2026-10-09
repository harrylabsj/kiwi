# Connect 未知结果的人工对账与恢复（2-18）

`CONNECTION_OPERATION_UNKNOWN` / `ENROLLMENT_STORE_BUSY` 是保守阻断，不是“超过TTL就可重做”。程序已能释放明确 read-only、效果未开始或有完整结果的本次 claim；效果开始后丢回执、崩溃锁或未知归属不能借 PID/时间推断未执行。此流程是操作指引，不是已实现的自动恢复命令。

## 先保留证据

1. 暂停该 enrollment 的并发连接/发布动作，保服务当前 PAUSED 等状态；不恢复经营状态，不重新 begin、不改 operation key。
2. 在受限目录保留原状态文件与日志的只读副本、SHA、时间范围和运行版本；记录原 enrollment_id、operation_claim.token/stage/state/expires_at/store_revision，以及创建 scope 与对应 claim。不要把 token/grant/私钥原文放工单、命令行或公开日志。
3. 区分 `merchant-enrollments.lock`（短RMW，pid/token归属），`enrollment-create-<sha256(scope)>.claim`（创建效果 unresolved）与 enrollment 的 `operation_claim`（阶段效果active/unknown）。它们不是同一种可按mtime清的锁；mtime、PID不存在、进程重启、超时均不构成效果证明。
4. 由原授权管理员/merchant owner通过既有已认证管理通道负责，绑定原 merchant/agent/runtime origin/key thumbprint/enrollment和operation。普通模型会话或仅知道ID者没有恢复授权；跨租户或凭据已撤销时先走现有权限流程。

## 取得权威结果（只读）

查询原 Catalog enrollment/binding/publication 与 runtime 状态，使用原 enrollment/operation或其可验证关联；保存已认证响应/签名回执摘要、issuer/key/签名校验结果、受众、绑定ID、目标origin、服务epoch、输入digest、结果revision及查询时间。仅“当前列表里没看到”不等于该 operation 未执行；副本延迟、分页/过滤、过期/撤回可能隐藏历史效果。runtime本地缓存或首签TTL不能覆盖Catalog权威事实。

| 权威结论 | 可做的事 | 不能做的事 |
|---|---|---|
| 确认已成功且与原绑定全部一致 | 将原回执纳入人工记录，核本地已保存结果/原ID可只读重建；如缺少受支持导入接口，交维护者做有界恢复方案，不重做效果 | 不另建enrollment/operation重复发布，不因为本地unknown改称失败 |
| 权威明确拒绝/撤销/终态失败且证明原效果未提交 | 记录原失败和授权边界，依据既有API/状态机决定后续新操作；旧ID/tombstone保留审计 | 不把404/暂时不可达/TTL到期当这类证明 |
| 仍未知、回执缺失、绑定冲突或签名无法核验 | 保 unknown/原claim和锁，升级人工维护；明确服务被阻断原因 | 不清锁、改token、换operation重驱，不自动恢复PAUSED |

## 恢复执行必须另有明确方案

本版本没有通用“清unknown后重试”CLI。需要修复持久状态时，维护者先提出绑定原ID/授权/权威证明的最小恢复方案；在副本演练，核CAS/store_revision、当前lock/claim owner、完整备份及回滚方案，再由原owner明确批准。不能在运行中手工编辑 JSON/unlink 来绕过RMW或未知效果屏障；也不能用TTL/PID自动化替代授权。完成后只读核原 operation 的唯一结果、binding/publication一致、没有额外效果，再由现有明确审批恢复服务（若需）；不得把技术恢复等同经营恢复授权。

工单验收清单：原ID与请求digest一致、证据可验证、恢复者权限明确、未知是否仍未知如实、没有新send/注册/发布、原claim/tombstone审计保留、服务状态未擅自改变。此文未运行生产恢复、未测试真实平台效果，也不声称解决所有崩溃窗口。
