# FileLeaseStore 合成长历史基线（3-6）

2026-10-09，Node v22.22.3/darwin，本机临时目录，100/1000/10000 token，每个token生成claim+renew，旧token另有release；20次isCurrent读取当前活跃token。脚本`scripts/probes/file-lease-history.mjs`使用实际owned dist实现，只在合成路径统计fs调用，结束删除整个fixture。不是生产容量、冷盘、并发压力或GC/泄漏证明。

| 历史token | 文件数 | p50上中位数 ms | p95 ms | 每次目录扫描/读record |
|---:|---:|---:|---:|---:|
|100|299|0.44|0.85|1/2|
|1000|2999|3.13|3.66|1/2|
|10000|29999|36.17|40.47|1/2|

原始结果在交付raw/lease-history.json（exit0）；p50取20个排序样本的上中位数，p95取第19个。30k目录项时每次均扫描约30k名称，但只读当前claim和该token的1个renew；不能再写成“逐一读取所有历史记录”。当前token若有更多renew，会额外读那些当前renew，不能把2读推广到任意数据。

每规模也实测活跃contender acquire被阻，原owner release后重新构造store acquire得到101/1001/10001，旧owner isCurrent=false；既有fencing语义保留，产品没有历史删除/压缩。RSS在10k样本20次读取后约98.6MB（该样本开始约57.8MB），包含进程/分配/缓存与此前fixture，不是单次峰值或泄漏结论，未强制GC/清OS缓存。

建议达到约1万token/3万文件时开始记录真实扫描/renew延迟、当前renew文件数及TTL余量。持续p95超过50ms，或renew总耗时接近TTL的10%，再提交具体checkpoint/分段方案；这不是自动清理阈值、部署硬门或已证明生产故障。较短TTL/慢盘应更早观测，不能套本机数据。当前仅确认线性容量债务，先不压缩。

未来方案的最低审查条件：原最大fencing token持久单调、当前活跃/未知owner证据与renew不丢；原claim竞争/旧owner fencing/corrupt/并发checkpoint崩溃窗口有强控；不得TTL删除claim令token重用；不得把lease到期当业务unknown效果未发生。本次没有实现或试运行任何checkpoint/GC。
