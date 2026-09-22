# merchant-core/storage — P2-1 存储原语目录

同类并发原语各只有一份实现，新代码不需要再发明第六种写法（设计 v0.1 §1）。

## 原语清单

- `transaction.ts` — `inImmediateTransaction`：事务包装（刀 1）。定型与逃逸口
  规则见模块头。
- `redact.ts` — `sanitize`：落库前错误文本脱敏（刀 3，原三处逐字复制收敛）。
- `schema.ts` — `ensureColumn`：幂等加列（刀 3，原三处逐字复制收敛）。
- `clock-skew-alerts.ts` — `recordClockSkewAlert`：clock_skew 告警 upsert +
  复活时作废旧投递（刀 3，原两处近似复制收敛；表存在性守卫的统一口径见
  模块头）。

## 时钟定型（刀 2；v5 交接报告 §1.1 三类结论成文化）

**业务时间一律构造器注入 ISO `now`**（`now?: () => string`，缺省回退墙钟）：
落库时间戳、过期判定、审计留痕等「写出去或被比较」的时间都是业务时间。
字面量墙钟出现在业务路径上，就是「上午绿下午红」那类缺陷的同族——
`tests/clock-injection-contract.test.ts` 头注释记录了 2026-09-22 真实发生的
一次（硬编码时刻一到，同一份代码门禁由绿转红）。

**基础设施时间用墙钟**：锁超时、重试截止、进程存活轮询、备份目录年龄、
临时文件名、elapsed 计时等「只约束本进程行为」的时间不注入——它们没有
可钉死的业务语义，注入只会增加噪音。

单位照上下文选：业务时间主流是 ISO 字符串；语义本就是毫秒比较的
（如 `FileLeaseStore` 的 TTL/过期接管）注入 `nowMs?: () => number`，不硬套 ISO。

例外（设计明确列为不做）：`clock-safety.ts` 的 `nowMs`——单位差异是接口
语义，改它牵动采样链路。
