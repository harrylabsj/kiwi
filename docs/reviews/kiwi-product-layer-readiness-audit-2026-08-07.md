# Kiwi 产品层重构就绪度审计（D0–D4）

Created: 2026-08-07
方法：把 `docs/kiwi-product-layer-refactor-rev1.2.md` §19 完成定义 D0–D4
逐条映射到实现代码 + 测试证据 + 真实 E2E 记录，标 ✅（直接实证）/
⚠️（部分或间接）/ ❌（缺失）。依据 = kiwi 仓 `main`（97 测试文件，
1412 tests 全绿，`npm run verify` 含 lint/typecheck/build/包冒烟）+
kiwi-catalog 仓 `main`（122 passed / 6 skipped，FastAPI 条件 skip）+
shopping-cli 仓（1170 passed / 11 skipped）。

**范围声明**：本审计评估产品层 CLI 命令面的就绪度，**不宣布 v1.1/v0.7.0
发布**；协议层（KNP/KTH/listing 契约）的审计由既有两个 readiness audit
管理；官网/市场文案属非工程侧，不在审计内。

## 结论摘要

| 评估 | 数量 | 条目 |
| --- | --- | --- |
| ✅ 直接实证 | 5 | D0–D4 |
| ⚠️ 部分或间接 | 0 | — |
| ❌ 缺失 | 0 | — |

## 逐条矩阵

| # | 完成定义 | 实现 | 测试证据 | 评估 |
| --- | --- | --- | --- | --- |
| D0 | 统一 CLI 树可执行 | `src/product-cli.ts`（buyer/merchant/network 帮助 + 聚合 doctor）+ cli.ts 路由（子命令组帮助优先、别名：merchant start → agent serve、buyer start → chat、旧命令全保留、骨架 fail-closed 带 D-x 提示） | `tests/product-cli.test.ts`（10 例：三组 --help/裸组帮助/骨架 fail-closed/D2-D1 参数校验/别名兼容/doctor 结构） | ✅ |
| D1 | `kiwi merchant init` 端到端 | `src/product-init.ts`：四步引导——shopping-cli 依赖检测（缺失 warning 不阻塞）、Kiwi↔shopping-cli 连接可达性（/health）、merchant profile 生成（**agent_id = shopping-cli merchant_id 身份统一**，D2 无需映射；token_env 只写环境变量名；0600 写盘；已存在 fail-closed/--force）、数据目录初始化（0700）；profile 版本用 RUNTIME_VERSION/PROTOCOL_VERSION 常量 | `tests/product-init.test.ts`（5 例：生成可被 loadProfile 读取/缺失 shopping-cli warning/不可达 warning/已存在 fail-closed+force/空 id） | ✅ |
| D2 | `kiwi merchant publish` 编排 | `src/product-publish.ts`：三步编排——(0) shopping-cli 版本门（D3 矩阵消费，fail-closed）、(1) agent 确认/注册（**幂等：先按 merchant 查询复用，没有再注册**；owner token 与 kiwi-catalog 逐字节一致；一商家一 agent 409 由此规避）、(2) 进程调用 shopping-cli listings publish-listings（--db 顶层参数顺序、60s 超时、spawn ENOENT 细节）；分步汇总 fail-closed | `tests/product-publish.test.ts`（6 例：成功路径/参数构造/owner token 固定向量/幂等复用/agent 短路/不兼容版本短路） | ✅ |
| D3 | `kiwi doctor` 聚合健康 | `src/product-compat.ts` 版本兼容矩阵**单一来源**（SHOPPING_CLI_COMPAT = >= 2.0.0 < 3.0.0 + parseVersion/compareVersions/versionInRange，parse 失败 fail-closed）；doctor 输出三组件状态（shopping_cli 含 compatible 判定与"超出支持范围"明细） | `tests/product-compat.test.ts`（7 例：解析/比较/范围/上下边界/fail-closed）+ product-cli doctor 结构断言 | ✅ |
| D4 | `kiwi buyer` 命令面 | `src/product-buyer.ts`：buyerInit（无需 shopping-cli 的 buyer profile）、buyerSearch（**复用 M3 KiwiCatalogSource.searchListings 链路**，输出 authority/requires_direct_confirmation 标注与 owner_agent_id，不伪装权威价）、buyerTasks（读本地 BuyerTaskStore）；start = chat 别名。**跨仓修复**：kiwi-catalog 注册自维护 merchants 影子行（搜索 merchant 投影非空，schema minLength 校验） | `tests/product-buyer.test.ts`（7 例：init 可 loadProfile/空 id/已存在、search 投影结构/网络 fail-closed、tasks 读取/缺数据目录引导）+ kiwi-catalog `test_register_creates_merchant_shadow_for_search_join` | ✅ |

## 真实 E2E 记录（2026-08-07）

1. **D1 → D2 闭环**：`merchant init` 生成 profile → `merchant publish` **直接用生成的 profile**（无需 --shopping-cli-merchant）→ `published: 1` → `/v1/listings/search` 召回（owner/authority/confirm 全对）→ 重复 publish 幂等（0 发 N 跳）。
2. **D3 冒烟**：`kiwi doctor` 输出 `shopping_cli.compatible: True`（2.0.0 在矩阵内）；publish 版本门通过。
3. **D4 闭环**：`merchant init → publish（1 条）→ buyer search "D4"` 召回 `count: 1`（merchant 投影非空、owner/authority/confirm 全对）。

## 审计注记（实现中修复的地基问题）

1. **一商家一 agent 幂等性**（D2）：二次 register 被 kiwi-catalog 409 拒绝——publish 改为"先按 merchant 查询复用，没有再注册"，重复 publish 安全（rev1.1 §4.5 要求）。
2. **身份统一**（D1/D2）：kiwi profile.agent_id 与 shopping-cli merchant_id 两套身份——init 让 agent_id = merchant_id（统一），publish 保留 `--shopping-cli-merchant` 显式映射兜底。
3. **spawn 参数顺序**（D2）：`--db` 是 shopping-cli 顶层参数，必须位于子命令之前。
4. **merchants 影子表无写入方**（D4）：搜索结果 merchant 投影依赖影子表但注册不创建——注册时自维护（INSERT OR IGNORE，不覆盖外部同步数据）。
5. **镜像表 vs catalog 状态漂移**（记录为边界，非本轮修复）：shopping-cli digest 去重假设 catalog 持久；`--rm` 容器重置后镜像表不感知。真实部署有持久 volume；catalog 侧丢失检测是未来 reconciliation 工作。
6. **profile runtime_version 是独立 schema 版本**（0.5.0），与产品版本（0.6.0）分离——用 RUNTIME_VERSION/PROTOCOL_VERSION 常量，避免硬编码漂移。

## 遗留

- `kiwi merchant listings / status / doctor`、`kiwi network *` 骨架命令（§19 范围外后置项）；
- 冷启动播种（v0.4 §23 ≥20 条真实 Listing，运营事项）；
- 官网/市场文案（非工程侧）；
- v0.7.0 发布声明（协议层审计 + 第三方互操作证据后）。
