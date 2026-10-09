# App 加固边界（2026-10-09）

- TrackingRuleType 的工具直调与 store 直调均经共同 runtime guard；非法类型返回 validation，工具在内部 claim 前拒绝；工具 schema enum、SQLite CHECK 仍保留。
- 主会话封装检查 appendMessage/_persist/_rewriteFile/getSessionFile 的可调用形状，不兼容明确失败关闭。该检查不是对未来所有依赖版本语义的证明；仍需实际 0600/no-thinking 兼容控制。streamSimple 仅管理 cacheRetention。
- AgentKernel 在开资源前验证注入时钟，并在初始化异常时关闭已获得的 SQLite handle；无效/抛错时钟报明确配置错误，合法 UTC 规范化保持。
- test-only 内存日预算 adapter 与生产 SQLite 的 unknown lease、同金额重复预约、异金额冲突、结算首次权威及已结算重约冲突契约一致；不改变生产预算/恢复策略。
- publish 不再保留早退之后不可达的 owner-token lookup/register；缺 enrollment 仍拒绝，不恢复 unsigned fallback。
- Weixin long-poll 仅 cursor 或 seen 状态发生变更时保存，保存失败不确认 dirty 状态；stop 刷新尚未保存的变化，重启去重合同保持。
- Memory retrieve 在当前主键权限/status 过滤后仍全量排序。本次合成 100/1,000/10,000 行、namespace 1% 选择测量无当前线上瓶颈证据；建议 principal 活跃记录达到 10,000 或实际 p95 达到 50ms 后复测，不能据该建议截断候选或改权限。
- Handoff 摘要测得重复扫描随候选数二次增长，改为每个 negotiation、每次 getter 内按原 candidate/handoff key 分组，保所有事件 kind、记录顺序、首次出现输出顺序及原 fold/find 选择语义。无持久缓存；额外短时开销为每事件至多两个引用以及每组一个数组/Map entry，O(E+C+H)。测量只针对摘要投影，不冒充磁盘 Ledger 全链 I/O 或生产延迟承诺。
