# Kiwi Commerce v1.1 发布决策（Release Decision）

Created: 2026-08-07
对象：v1.1（Commerce 能力层：Transaction Handoff / KiwiCatalogSource 消费端 /
CommerceDataSource 数据侧边界）
依据：`kiwi-commerce-v1.1-readiness-audit-2026-08-07.md`（21/21 完成定义实证）
+ 本日部署验证与基线复核。

## 1. 决策摘要

**建议：v1.1 维持 Draft（rev1.4.1 约定），代码与部署就绪度已达成，唯一缺失的
发布前置是第三方互操作证据（wire 级）。** 本决策不宣布发布——按 rev1.4.1
文档自身约定，发布决定由项目所有者作出；本文档提供发布所需的全部已备证据与
未完成项清单。

## 2. 已备证据

### 2.1 完成定义（21/21 直接实证）

`kiwi-commerce-v1.1-readiness-audit-2026-08-07.md`：21 条完成定义全部 ✅
直接实证、0 部分、0 缺失。含三轮 code-review 修复后的实现引用同步
（幂等锁、URL 安全 DNS 复查、交付状态机、三域映射等）。

### 2.2 基线验证（2026-08-07，架构调整 `3bfa46b` 后）

| 项 | 结果 |
| --- | --- |
| kiwi `npm run verify` | ✅ lint / typecheck / build / **90 文件 1352 tests 全绿** / 包冒烟（pack → install → CLI → 生产依赖导入） |
| kiwi-catalog `pytest` | ✅ **66 passed / 5 skipped**（FastAPI 条件 skip） |
| 架构调整 | 数据接入收窄为 shopping-cli 单一入口（ERP/本地库下沉 shopping-cli 仓，migration v16）；审计 #5/#6/#7 证据落点同步 |

### 2.3 部署验证（本日新增）

**Docker（容器形态）**：
- `docker build`（python:3.13-slim + `pip install .[api]`）成功；
- 容器内全链路 API 冒烟：`/health` → register → search（含三态域过滤）→
  get → suspend（admin，折叠 suspended + 按 administrative_state 过滤命中）
  → reinstate（恢复 discovered）→ verify（端点可用，profile 阶梯正常返回）；
- **重启持久性**：`docker restart` 后已注册 agent 数据保留（volume `/data`）；
- 环境变量注入（`KIWI_CATALOG_ADMIN_TOKEN` / `KIWI_CATALOG_OWNER_TOKEN_SECRET`）
  生效，敏感配置不落镜像层。

**systemd（VM 形态）**：
- unit 文件核对：`ExecStart` 的 `kiwi-catalog-api` console script 与
  pyproject `[project.scripts]` 一致；
- venv 安装（`pip install -e '.[api]'`）+ `kiwi-catalog-api --db … --host …
  --port …` 启动冒烟通过（FastAPI 启动 + `/health` 200）——systemd
  ExecStart 的等价路径。

**部署形态约束**：SSRF fetcher 需要真实网络栈（socket 级 DNS→IP 校验），
目标形态为 VM/容器；serverless（如 Cloudflare Workers）不适用——README
已明确标注。

### 2.4 代码质量

三轮 code-review（2026-08-07）修复：9 条 P1（资金/安全面）+ 18 条 P2/P3
+ 收尾批次（runaway 线程取消、P3 批量清理、关键测试补齐）。无遗留
P1/P2（唯一保留项为 loopback 开发配置的 allowlist 权衡，已文档化）。

## 3. 未完成项（发布前置）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 第三方互操作证据（wire 级） | ❌ 未完成 | 审计文档明确禁止宣称：与真实对端（外部 A2A 节点 / shopping-cli hosted / 第三方 catalog）的 wire 级互操作验证未执行；当前互操作证据为测试内建（KNP conformance vectors、双实现 fixture） |
| 产品化打磨 | 部分 | CLI/文档/部署物已齐（FEATURES.md、Dockerfile、systemd unit）；运营面（监控告警、备份策略）未做 |
| 版本号 | 待定 | kiwi 包版本当前 1.0.0（A2A v1.0）；v1.1 发布时的版本 bump 由发布决定一并确定 |

## 4. 决策选项

1. **维持 Draft + 待互操作证据（推荐）**：代码与部署就绪度已达成；在
   互操作证据完成前维持 rev1.4.1 Draft 状态，审计文档不宣布发布。
2. **条件发布**：宣布"代码就绪 + 部署验证通过"，互操作证据列为发布后
   第一个里程碑（文档明确标注未验证范围）。
3. **直接发布**：不推荐——违反 rev1.4.1 约定（发布决定含第三方互操作证据）。

## 5. 发布时动作清单（决策后执行）

- [ ] 版本 bump（kiwi 包 + kiwi-catalog 包）+ CHANGELOG
- [ ] rev1.4.1 架构文档状态 Draft → 正式（随发布决定）
- [ ] 审计文档范围声明更新（发布后不再维持"不宣布发布"措辞）
- [ ] 互操作证据里程碑（wire 级对真实对端）——发布后第一优先

---
本决策文档只陈述证据与建议；发布决定由项目所有者作出。
