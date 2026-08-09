# Kiwi 三产品跨仓库 P2 架构设计

- 状态：实施中（T1–T5、T7、T10 已落地；T6 已落地固定 SHA 组合门禁、离线组合锁候选预检与 `workflow_dispatch` 受控跨进程 E2E，尚未在 GitHub 受控环境实际 dispatch；T8/T9 已完成多组纯 facade 拆分，shopping-cli 与 kiwi-catalog 的请求体/异常映射、API 路由装配、verification stage/evidence/audit/profile-index policy、queue ledger SQL、verification evidence SQL、trust observation SQL、catalog audit SQL、catalog query assembly、negotiation gates、negotiation contract、snapshot projection 与 decision message projection 纯模块已独立成模块；T11 已落地受保护 OIDC 发布工作流与无发布权限的签名演练；T12 已具备 registry 下载校验、manifest fail-closed 测试和离线/只读回滚候选验证，真实 registry 回滚待受控推进）
- 日期：2026-08-09
- 范围：`kiwi`、`kiwi-catalog`、`shopping-cli`
- 目标：完成统一契约包、组合 CI、重复服务脚手架重构，以及依赖锁定、SBOM、签名与可验证发布链路
- 性质：产品组合底盘保障，不改变三个产品的业务边界

## 1. 结论先行

本设计保留三个独立产品仓库，不合并为 monorepo，也不立即建立一个大型共享运行时。

采用四个明确决定：

1. **`kiwi/contracts` 成为机器可读契约的组合级权威源**。`kiwi/spec` 保留为公开人类规范及托管镜像，不能再由人工复制维护 schema。
2. **先共享行为，再考虑共享代码**。先建立跨仓库契约测试和 Python 服务一致性套件；只有连续两个发布周期保持稳定、且实现相似度足够高的纯基础能力，才抽成共享运行时包。
3. **组合 CI 由 `kiwi` 仓编排**。每个仓库的 PR 先通过自己的契约门；组合流水线支持固定 SHA 的手动预合并验证和每日默认分支验证，不引入长期跨仓库 PAT。
4. **发布物一次构建、多次验证、原物发布**。Node 使用 `package-lock.json`，两个 Python 项目使用 `uv.lock`；所有正式发布物生成 SBOM、来源证明和签名/证明，并可由用户侧命令验证。

目标状态不是“所有代码都 DRY”，而是：契约只有一个权威源、行为只有一套验收标准、发布物可以复现和追溯，产品实现仍可按自身节奏演进。

## 2. 当前事实与问题

本节只记录 2026-08-09 在三个仓库直接观察到的事实。

| 领域 | 当前事实 | 风险 |
| --- | --- | --- |
| 契约 | `kiwi/contracts`、`kiwi/spec`、`shopping-cli/shopping_cli/contracts` 和 `kiwi-catalog` 内 Python schema 同时存在 | 人工复制遗漏、owner 不清、发布先后不一致 |
| CandidateAgent | `kiwi/contracts/candidate-agent-dto-1.0.README.md` 仍指向已不存在的 `shopping_cli/agent_catalog/candidate_dto.py`，实际实现已在 `kiwi-catalog/kiwi_catalog/agent_catalog/candidate_dto.py` | 文档与代码 owner 漂移，下一次改契约容易改错位置 |
| negotiation 0.1 | Kiwi 与 shopping-cli 的四个 schema 当前 SHA-256 一致 | 当前未漂移，但依赖人工维持，缺少发布级锁定 |
| dialect | schema 同时使用 JSON Schema draft-07 和 2020-12 | 验证器语义可能不同，不能在一次 P2 中静默升级 dialect |
| CI | shopping-cli 有 GitHub Actions；kiwi 与 kiwi-catalog 没有仓库 CI | 单仓和跨仓变更没有统一合并门 |
| Action 安全 | shopping-cli 使用 `actions/checkout@v4`、`setup-python@v5`、`setup-node@v4` 标签 | 标签可移动，发布工作流供应链边界不足 |
| Python 依赖 | kiwi-catalog、shopping-cli 均无仓库级 lockfile；catalog 的运行时依赖没有版本范围 | 本地、CI、容器解析结果可能不同 |
| Node 依赖 | kiwi 已有 `package-lock.json` | 可直接切换为 `npm ci` 与 lockfile 强制门 |
| 重复脚手架 | 两个 Python 仓库都有 `api/auth.py`、`fallback_asgi.py`、`idempotency.py`、`limits.py`、`route_registry.py`、`db/session.py`、`core/errors.py` | 同一安全修复需做两次，但这些文件已有实质差异，不能整文件抽取 |
| 热点文件 | catalog 有 1850/1354/1314/970 行热点；shopping-cli 有 1353/1281/929 行热点 | 评审困难、跨功能修改冲突、测试定位慢 |
| 发布 | 已有包冒烟和 Dockerfile，但缺统一 SBOM、签名、来源证明、发布后验证 | 用户无法证明下载物来自哪次构建，回滚依据不足 |

一个关键兼容陷阱：现有 schema 广泛使用 `additionalProperties: false`。因此“增加一个可选字段”对新 schema 可能是 minor，但旧消费者仍会拒绝新生产者输出。版本号本身不能解决兼容性，必须同时设计生产者启用顺序和版本协商。

## 3. 目标与非目标

### 3.1 目标

- 每个机器可读契约只有一个可审计的权威源。
- 每个消费者固定到契约 bundle 的版本、源提交和 SHA-256。
- 契约变更在合并前回答两个问题：旧消费者是否还能读，新生产者是否会提前发出新字段。
- 任意固定的三仓库 SHA 组合都能在 CI 中重建和验证。
- 两个 Python 服务对安全边界、错误形状、请求上限和幂等语义有共享验收标准。
- 大文件按职责拆分，但不同时做行为改动。
- 每个正式发布物都有 lock、SBOM、来源证明和用户可执行的验证命令。
- 发布失败可以停止在 publish 前；发布后发现问题可以按 digest 回滚。

### 3.2 非目标

- 不把三个仓库合并为 monorepo。
- 不统一 Kiwi TypeScript 运行时与 Python 服务实现。
- 不抽取共享数据库模型、迁移链、业务认证策略或领域幂等状态机。
- 不在本次把所有 draft-07 schema 升级为 2020-12；dialect 变更按独立 major contract 处理。
- 不要求每个普通 PR 自动调用另一个仓库的特权 workflow。
- 不引入自建制品库、私有 CA、长期签名私钥或 KMS。
- 不借架构重构改变现有 API、状态机或用户可见行为。

## 4. 设计原则

1. **单一权威源不等于单一运行时**：schema 可以统一，验证器可以按语言保留。
2. **行为一致性优先于代码复用**：先证明两个服务应该表现一致，再抽公共实现。
3. **严格消费者需要显式发布波次**：先升级消费者，再允许生产者发送新增字段。
4. **固定 SHA，不运行模糊引用**：组合 CI 的输入是 40 位 commit SHA，不是 branch 最新状态。
5. **不在有发布权限的 job 中执行 PR 代码**：测试与发布使用独立 workflow、权限和触发条件。
6. **构建一次**：被测试、生成 SBOM、签名和发布的是同一组 bytes。
7. **默认无长期密钥**：npm/PyPI/GitHub/GHCR 优先使用 OIDC 与短期身份。
8. **结构变更和行为变更分开**：热点文件拆分 PR 只做移动和接口收窄，先由 characterization tests 锁定行为。

## 5. 目标架构

```text
                         kiwi repository
              ┌─────────────────────────────────┐
              │ contracts/  machine authority   │
              │ spec/       public human spec   │
              │ integration/portfolio.lock.json │
              │ portfolio integration workflow  │
              └───────────────┬─────────────────┘
                              │ deterministic bundle
                 kiwi-contracts-X.Y.Z.tar.gz
                    + manifest + SHA256SUMS
                              │
                ┌─────────────┼─────────────┐
                │             │             │
        ┌───────▼──────┐ ┌────▼─────────┐ ┌─▼─────────────┐
        │ kiwi runtime │ │ kiwi-catalog │ │ shopping-cli  │
        │ TS validators│ │ Python load  │ │ Python load   │
        │ contracts.lock│ │ contracts.lock│ │ contracts.lock│
        └───────┬──────┘ └────┬─────────┘ └─┬─────────────┘
                │             │             │
                └─────────────┼─────────────┘
                              │
                 shared conformance behavior
               + cross-repo golden/E2E verification
```

运行时不从网络下载契约。每个产品在构建时使用已固定且已校验 digest 的 vendored snapshot，避免启动依赖外部 registry，也避免远程契约被替换。

## 6. 统一契约包设计

### 6.1 权威目录

建议把 `kiwi/contracts` 整理为以下逻辑结构；迁移可保留旧路径软兼容一个 minor 版本，但新代码只读新路径。

```text
contracts/
  manifest.json
  knp/1.0/schema.json
  kth/0.1/*.schema.json
  catalog/agent-record/1.0/schema.json
  catalog/listing-record/1.0/schema.json
  catalog/listing-search-result/1.0/schema.json
  candidate-agent/1.0/schema.json
  legacy/shopping-negotiation/0.1/*.schema.json
  vectors/
    valid/<contract>/*.json
    invalid/<contract>/*.json
  conformance/python-service/
    README.md
    cases/*.json
```

`kiwi/spec` 中公开托管的 schema 必须由 `contracts/` 生成或复制后进行逐字节校验。CI 禁止两个目录出现非生成式差异。

### 6.2 Bundle manifest

`manifest.json` 至少包含：

```json
{
  "bundle": "kiwi-contracts",
  "bundle_version": "1.0.0",
  "source_commit": "40-hex-sha",
  "generated_at": "2026-08-09T00:00:00Z",
  "contracts": {
    "candidate-agent": {
      "version": "1.0.0",
      "dialect": "draft-07",
      "owner": "kiwi-catalog",
      "path": "candidate-agent/1.0/schema.json",
      "sha256": "..."
    }
  }
}
```

约束：

- `generated_at` 固定为源提交时间（`SOURCE_DATE_EPOCH`），不读取构建机器当前时间，保证相同源提交可重现相同 tarball。
- tar 条目顺序、mtime、uid/gid 和压缩参数固定。
- 发布同时生成 `SHA256SUMS` 和 bundle attestation。
- bundle 版本描述打包结构；每个 contract 有独立版本，禁止用一个全局版本掩盖单个契约的 breaking change。

### 6.3 单一源与生成规则

- JSON Schema 文件是机器契约权威源。
- Python 不再把大型 dict 当作另一个 canonical schema；改为加载 vendored JSON。
- TypeScript 类型、Python TypedDict/dataclass 可以生成，但生成物头部必须标记 source contract 和 digest。
- 任何手写类型都必须由 golden vectors 验证，不能仅比较字段名。
- `candidate-agent-dto-1.0.README.md` 的旧 shopping-cli owner 路径在迁移时删除或改为 manifest 链接。

### 6.4 版本规则

| 变化 | contract 版本 | 额外要求 |
| --- | --- | --- |
| 注释、示例、描述修正，不改变 accepted instances | patch | old/new corpus 双向等价 |
| 放宽输入、增加新 schema、增加消费者可选能力 | minor | 旧 valid vectors 必须全部通过；生产者默认输出不能提前变化 |
| 增加 response 字段且旧消费者 strict reject | minor contract + rollout gate，必要时 major media version | 先消费者、后生产者；必须有版本协商或双版本输出 |
| 删除/重命名字段、收窄类型/enum、改变语义 | major | 并行支持旧 major，给出弃用期限 |
| JSON Schema dialect 变化 | major | AJV 与 Python validator parity suite 必须同时通过 |

兼容检查不仅做 schema diff，还做集合检查：

```text
old valid vectors ──must pass──> new consumer schema
new default output ─must pass───> every supported old consumer schema
new opt-in output  ─must pass───> negotiated consumer schema
invalid vectors    ─must fail───> JS validator AND Python validator
```

### 6.5 版本协商

对已经 strict 的 JSON body，不通过增加新 body 字段实现协商；使用 HTTP header：

- 请求：`Kiwi-Accept-Contract: candidate-agent/1.0, candidate-agent/2.0`
- 响应：`Kiwi-Contract: candidate-agent/1.0`
- 未发送请求 header 时，服务端保持当前稳定版本。
- 服务端不能满足时返回 `406 contract_version_not_supported`，并返回支持版本 header。
- A2A/KNP envelope 已有协议版本的位置继续使用协议内版本，不重复加 HTTP header。

### 6.6 消费者锁文件

三个仓库各自提交 `contracts.lock.json`：

```json
{
  "bundle_version": "1.0.0",
  "source_repository": "harrylabsj/kiwi",
  "source_commit": "40-hex-sha",
  "bundle_sha256": "...",
  "contracts": {
    "candidate-agent": "1.0.0",
    "catalog-agent-record": "1.0.0"
  }
}
```

同步命令必须是显式操作：`contracts sync --lock contracts.lock.json`。CI 的 `contracts verify` 只验证，不自动更新，避免测试时悄悄接受新契约。

### 6.7 Golden vectors

每个 contract 至少有：

- 最小合法对象、完整合法对象、边界值对象。
- 每个 required 字段缺失。
- 每个 enum 非法值。
- unknown/private 字段。
- 错误类型、null、空字符串、超长数组。
- 已知 legacy alias。
- 与 KTH destination vocabulary 的交叉断言。

同一 vectors 由 AJV 与 Python `jsonschema` 执行。任何结果不同都阻断 contract release。

## 7. 组合 CI 设计

### 7.1 三层门

```text
Layer 1: 每仓 PR（必过）
  lint/type/test/package-smoke/contracts verify
                  │
                  ▼
Layer 2: 固定 SHA 组合（契约变更或协调 PR 必过）
  shopping-cli@SHA → kiwi-catalog@SHA → kiwi@SHA
                  │
                  ▼
Layer 3: 每日 main canary（报警，不自动回滚）
  三仓最新 main + 当前已发布 artifacts
```

### 7.2 工作流归属

| 仓库 | 新增/调整 workflow | 责任 |
| --- | --- | --- |
| kiwi | `ci.yml` | Node 22/当前 LTS、lint、typecheck、full test、package smoke、contract bundle verify |
| kiwi-catalog | `ci.yml` | Python 3.11/3.13、lock check、lint/type/test、wheel/container smoke、contract verify |
| shopping-cli | 更新 `ci.yml` | 改用 locked install、Action SHA pin、保留 3.11/3.13、contract verify |
| kiwi | `portfolio-integration.yml` | checkout 三个固定 SHA，执行组合矩阵与 artifact compatibility |
| 三仓 | `release.yml` | tag-only、environment approval、OIDC、build-once、attest/publish/verify |

### 7.3 `portfolio.lock.json`

中央组合工作流只接受以下 manifest：

```json
{
  "kiwi": {"repository": "harrylabsj/kiwi", "sha": "..."},
  "kiwi_catalog": {"repository": "harrylabsj/kiwi-catalog", "sha": "..."},
  "shopping_cli": {"repository": "harrylabsj/shopping-cli", "sha": "..."},
  "contracts": {"bundle_version": "1.0.0", "sha256": "..."}
}
```

- repository 名称固定 allowlist。
- SHA 必须是完整 40 位 hex，checkout 后再次验证 `git rev-parse HEAD`。
- 测试 job 权限固定 `contents: read`，不加载发布 secrets。
- fork/PR 代码不能运行在有 `id-token: write` 或 packages write 的 job。

### 7.4 组合流水线

```text
validate manifest
      │
      ├── checkout exact SHAs
      ├── verify contract lock/digests
      ├── build shopping-cli wheel + start local Commerce API
      ├── build/start kiwi-catalog against isolated temp DB
      ├── build kiwi package
      ├── seed merchant/product/agent/listing fixtures
      ├── shopping projection → catalog register/publish
      ├── kiwi discover/search → fresh verify → negotiate → handoff
      ├── assert KNP/KTH/CandidateAgent/listing golden outputs
      └── upload logs, matrix and artifact digests
```

所有网络服务监听 loopback，使用随机端口和临时目录；CI 不访问生产 Catalog。

### 7.5 触发策略

- `pull_request`：只跑当前仓 Layer 1。
- 修改 `kiwi/contracts/**`：在 kiwi PR 中跑 Layer 2，消费者默认使用 main SHA。
- 协调式跨仓 PR：维护者在中央 workflow 手工输入三个完整 SHA；结果链接回各 PR。
- `schedule`：每日运行三个 main SHA，并保存最近 30 天结果。
- `release`：目标仓 release job 先验证一个已通过的 Layer 2 manifest digest。

第一阶段不使用跨仓库 PAT。若后续每周协调 PR 超过 3 次、人工 dispatch 已成为明确瓶颈，再评估只读 GitHub App；在此之前不花这个创新额度。

### 7.6 合并顺序

契约变化必须采用 expand/contract：

```text
1. contracts 发布新版本（旧版本仍保留）
2. 所有消费者接受新旧版本，但生产者仍发旧形状
3. Layer 2 证明新旧组合均通过
4. 生产者在协商后发送新形状
5. 观察至少两个发布周期
6. 单独 PR 移除旧版本；breaking change 才进入 major
```

## 8. 重复服务脚手架重构

### 8.1 不直接抽公共库的原因

同名不等于同语义。当前 diff 已证明：

- `limits.py` 和 `core/errors.py` 接近同源，适合优先统一行为。
- `fallback_asgi.py` 有相同骨架，但路由、错误映射和功能已经分化。
- `auth.py`、`idempotency.py`、`route_registry.py`、`db/session.py` 包含各自领域策略，不应整文件共享。

直接抽一个大 `kiwi-service-core` 会让业务差异变成条件分支，最终得到一个修改任何服务都可能影响另一个服务的隐性单体。

### 8.2 先建立 dev-only conformance kit

`contracts/conformance/python-service` 提供测试用例和 adapter protocol，不成为生产运行时依赖。

每个服务实现一个 test adapter：

```python
class ServiceConformanceAdapter(Protocol):
    def request(self, method, path, *, headers, body) -> Response: ...
    def issue_token(self, actor) -> str: ...
    def idempotent_endpoint(self) -> str: ...
    def max_body_bytes(self) -> int: ...
```

一致性套件覆盖：

- JSON object/body 类型约束和最大 body/depth/items 限制。
- Bearer header 解析、错误不回显 secret、响应 `no-store`。
- 401/403/404/409/413/422/429/500 的公共 error envelope。
- 幂等性：同 key 同 payload replay；同 key 异 payload 409；actor 隔离。
- FastAPI 与 fallback ASGI 路由、状态码、header 和 body 一致。
- request/correlation id 传播和日志脱敏。
- SQLite newer-schema fail-closed、busy timeout、文件权限。

幂等性在这里指“同一个请求重复到达时，系统只产生一次业务副作用”。套件只统一外部可观察行为，不强迫两个服务使用同一表结构。

### 8.3 共享代码抽取门槛

纯基础能力同时满足以下条件才允许抽取：

1. 两个仓库已通过同一 conformance case。
2. 实现连续两个发布周期没有领域分叉。
3. 代码相似度高，抽取后不需要按产品名分支。
4. 运行时依赖不增加，或新增依赖有明确安全收益。
5. 独立版本、changelog、兼容范围和回滚路径已经设计。

第一批候选仅限：error 基类、JSON/resource limit 纯函数、header/token redaction 纯函数。数据库 session、route registry、auth policy 和 idempotency persistence 明确留在各仓库。

### 8.4 热点拆分目标

软上限为 600 行；超过不自动失败，但必须有单一职责说明。拆分先补 characterization tests，再只移动代码。

| 当前热点 | 建议模块边界 | 顺序 |
| --- | --- | --- |
| catalog `services/agent_verification.py` 1850 | pipeline stages / evidence policy / queue ledger / state transition orchestration | 先抽纯 stage，再抽 persistence |
| catalog `agent_catalog/sqlite_repository.py` 1354 | agents / endpoints / search / audit repositories | 保持 repository facade 兼容 |
| catalog `api/app.py` 1314 | app factory / route installation / error mapping / FastAPI adapter | 先固定 route parity |
| catalog `handlers/agent_catalog.py` 970 | read handlers / write handlers / validation mapping | 不改变 URL 与 response shape |
| shopping `api/app.py` 1353 | app factory / route installation / error mapping / transport adapters | 与 catalog 共用 conformance，代码仍本地 |
| shopping `core/catalog.py` 1281 | merchant / products / agents / projections | 以 transaction boundary 分模块 |
| shopping `services/negotiation.py` 929 | schema validation / state transition / replay / serialization | 保持单一 public facade |

### 8.5 重构迁移法

每个热点按以下循环单独提交：

```text
characterization tests green
          │
          ▼
introduce internal facade
          │
          ▼
move one responsibility, no behavior change
          │
          ▼
full tests + conformance + composition CI
          │
          ▼
delete old path after import graph confirms zero callers
```

结构 PR 禁止同时修改 schema、状态机规则或错误文案；这些行为变化另开 PR。

## 9. 依赖锁定、SBOM 与签名发布

### 9.1 锁定策略

| 项目 | 声明文件 | 锁文件 | CI/install |
| --- | --- | --- | --- |
| kiwi | `package.json` | 已有 `package-lock.json` | `npm ci`; CI 验证 lock 未变化 |
| kiwi-catalog | `pyproject.toml` 保留兼容范围 | 新增 `uv.lock` | `uv sync --locked --all-extras`; release 用 `--no-dev` |
| shopping-cli | `pyproject.toml` 保留兼容范围 | 新增 `uv.lock` | 同上 |

Python wheel 的 metadata 不能把所有依赖钉死，因为下游需要求解兼容范围；CI、Docker 和发布环境必须使用 lockfile 的精确解析。`uv.lock` 与 uv 工具版本一起固定，Dependabot/Renovate 通过 PR 更新，不在正常 CI 中自动升级。

Docker 构建从 lock 导出带 hash 的生产依赖，基础镜像固定到 digest。构建必须失败于 lock 过期，而不是现场重新求解。

### 9.2 正式发布物清单

| 产品 | 正式 artifact |
| --- | --- |
| kiwi | npm tarball |
| kiwi-catalog | wheel、sdist、OCI image |
| shopping-cli | wheel、sdist、OCI image、现有 npm/plugin tarball |
| portfolio contracts | deterministic tar.gz、manifest、SHA256SUMS |

SBOM（软件物料清单，即 artifact 中包含哪些组件和版本）按 artifact 生成，不按源码目录猜测：

- Python：由 locked environment 导出 CycloneDX 1.5，并对 wheel 实际内容补 artifact metadata。
- Node：从 `package-lock.json` 生成 CycloneDX。
- Container：BuildKit 生成 SPDX SBOM 与 provenance。
- SBOM 与目标 artifact digest 绑定，并作为 GitHub/PyPI/registry attestation 附件。

### 9.3 Build-once 发布流水线

```text
signed tag / protected release workflow
                 │
                 ▼
        checkout full SHA + locked deps
                 │
                 ▼
      build artifacts ONCE in clean runner
                 │
        ┌────────┼─────────┐
        ▼        ▼         ▼
   artifact   package    composition
   smoke      tests      compatibility
        └────────┼─────────┘
                 ▼
       generate SBOM + provenance
                 ▼
       attest/sign exact digests
                 ▼
    manual protected environment gate
                 ▼
 npm/PyPI/GHCR/GitHub Release publish
                 ▼
 download by digest + verify + smoke
```

publish job 下载前一个 job 的 immutable artifact，禁止重新 build。

### 9.4 身份与签名

- npm：Trusted Publishing 或 `npm publish --provenance`，使用 GitHub-hosted runner 和 OIDC；不保存长期 npm token。
- PyPI：Trusted Publisher + 官方 PyPA publish action；默认上传 publish attestation。
- GitHub Release 二进制/bundle：GitHub artifact attestation，用户用 `gh attestation verify` 验证。
- GHCR image：以 image digest 调用 cosign keyless sign；验证时同时限制 repository workflow identity 和 OIDC issuer。
- 所有第三方 GitHub Action 固定到完整 commit SHA，并在同一行注释对应 tag；Dependabot 维护 SHA 更新 PR。

签名证明“谁在什么 workflow 构建了哪些 bytes”，不证明代码没有漏洞；测试、review 和 branch protection 仍是前置控制。

### 9.5 Workflow 权限边界

测试 workflow：

```yaml
permissions:
  contents: read
```

发布 workflow 按 job 最小授权：

```yaml
permissions:
  contents: read
  id-token: write
  attestations: write
  packages: write
```

- publish 仅允许 tag 或手动选择 protected environment。
- workflow 文件由 CODEOWNERS 守护。
- 不使用 `pull_request_target` checkout PR head。
- release job 不执行来自 fork 的代码。
- cache key 包含 OS、runtime、lockfile hash；发布 job 默认禁用第三方依赖 cache。

### 9.6 用户验证与回滚

每个 release 附带 `VERIFY.md`：

```text
1. verify registry provenance/attestation identity
2. verify artifact digest against release manifest
3. verify SBOM attestation targets the same digest
4. install/run package smoke
```

回滚不覆盖已有 tag/image：

- npm/PyPI 发布新 patch；不复用版本号。
- OCI 以 digest 回滚部署；tag 只作为可读别名。
- Contract bundle 保留所有已发布 major/minor；消费者锁回上一 digest。
- 组合 CI 保存导致回滚的三仓 SHA manifest，作为后续回归向量。

## 10. 安全威胁模型

| 威胁 | 控制 | 验证 |
| --- | --- | --- |
| 契约副本被手改 | canonical source + digest lock + generated-copy check | 修改 vendored file 但不改 lock，CI 必须失败 |
| 新生产者提前发新字段 | header negotiation + producer rollout gate | old consumer matrix 必须仍通过 |
| 跨仓 ref 被 branch 移动 | 仅完整 SHA + checkout 后复验 | branch/ref 输入被拒绝 |
| 恶意 PR 获取发布权限 | test/release workflow 隔离，无 PR secrets | fork PR 检查 permissions |
| Action tag 被替换 | full SHA pin + Dependabot | policy scan 禁止 `uses: ...@vN` |
| 依赖解析漂移 | package-lock/uv.lock + locked install | lock stale 或 install 改 lock 即失败 |
| 发布 token 泄露 | OIDC Trusted Publishing/keyless sign | 仓库无长期 registry token |
| build 与 publish bytes 不同 | build once + artifact digest handoff | publish job 禁止 build 命令 |
| SBOM 与 artifact 不对应 | attestation subject digest 绑定 | 下载后离线验证 digest |
| shared core 变成隐性单体 | conformance first + extraction threshold | 产品分支/配置分支审查门 |

## 11. 生产失败模式

| 新路径 | 现实失败 | 测试 | 错误处理 | 用户可见性 |
| --- | --- | --- | --- | --- |
| contract sync | registry/Release 不可达 | 使用本地缓存与 corrupt cache 两种 case | 无缓存则 fail-closed | 明确提示缺哪个 bundle/digest |
| digest verify | tarball 被替换 | 篡改 1 byte | 拒绝解包 | 显示 expected/actual digest，不输出凭据 |
| schema parity | AJV 与 Python 对 format 解释不同 | 同一 valid/invalid corpus | 阻断 contract release | CI 列出 vector 与 validator |
| version negotiation | 客户端只支持旧 major | 406 integration test | 返回 supported versions | 可升级，不静默降级 |
| composition checkout | 输入 SHA 不存在/非 allowlist repo | manifest validation tests | job 在执行代码前失败 | workflow summary 指明字段 |
| local API startup | 端口冲突/health timeout | 随机端口、慢启动、崩溃 case | kill 全部子进程、收集日志 | CI 指向具体服务日志 |
| locked install | lock 与 pyproject 不一致 | 修改依赖不更新 lock | `--locked` 失败 | 给出更新命令 |
| attestation | OIDC/透明日志临时不可用 | publish dry-run with denied id-token | publish 停止，不上传 unsigned artifact | release 未创建，不产生半发布 |
| post-publish verify | registry 最终一致性延迟 | bounded retry | 超时后标记 release failed | 保留 digest 和重试指引 |
| hotspot split | import/call path 遗漏 | characterization + full suite | facade 保留一个 deprecation 周期 | 用户行为不变化 |

没有允许“无测试 + 无错误处理 + 静默失败”的新路径。

## 12. 测试设计

```text
CODE PATHS                                             USER/OPERATOR FLOWS
[+] Contract bundle                                   [+] Developer changes schema
  ├── [★★★] deterministic build                         ├── [→E2E] old consumer still reads
  ├── [★★★] hash/manifest verify                         ├── [→E2E] coordinated SHA matrix
  ├── [★★★] JS/Python validator parity                   └── [★★★] breaking change rejected
  └── [★★★] version negotiation

[+] Python service conformance                        [+] Service maintainer refactors app
  ├── [★★★] auth/error/resource limits                  ├── [★★★] FastAPI/fallback parity
  ├── [★★★] idempotent replay/conflict/isolation        ├── [★★★] full existing test suite
  └── [★★★] DB/session failure boundaries               └── [★★★] no response-shape drift

[+] Release pipeline                                  [+] User installs/verifies release
  ├── [★★★] locked reproducible install                 ├── [→E2E] registry provenance verify
  ├── [★★★] artifact smoke before publish               ├── [→E2E] SBOM subject digest verify
  ├── [★★★] least-permission policy scan                └── [★★★] rollback to prior digest
  └── [→E2E] build-once artifact identity

COVERAGE TARGET: every branch above tested before its phase is marked complete.
Legend: ★★★ = happy + edge + failure; [→E2E] = cross-component integration test.
```

### 12.1 必跑矩阵

| Suite | 触发 | Gate |
| --- | --- | --- |
| Contract lint/vectors/parity | contract PR、三仓 PR | merge-blocking |
| Repo full tests | 每个 PR | merge-blocking |
| Package/wheel/container smoke | 每个 PR 或 release candidate | merge/release-blocking |
| Fixed-SHA composition | contract PR、协调 PR、release | merge/release-blocking |
| Main nightly composition | schedule | 报警，连续两次失败升级为 P1 |
| Attestation/signing dry run | workflow 变更 PR | merge-blocking，无 publish 权限 |
| Post-publish download/verify | release | channel-promotion-blocking；首个 registry 已发布时标记 unhealthy 并停止后续 channel |

### 12.2 回归红线

- 现有测试总数不能因为模块拆分下降。
- 任何被发现的历史跨仓漂移都必须成为 golden vector 或 composition regression。
- 新增 contract 字段必须同时有 old-consumer 和 negotiated-consumer case。
- 修改 workflow 必须通过静态 permissions/Action SHA policy test。

## 13. 性能与运行成本

- PR Layer 1 目标：冷运行 ≤10 分钟，缓存命中 ≤6 分钟。
- 固定 SHA composition 目标：≤15 分钟；nightly ≤20 分钟。
- 合同 bundle 目标：压缩后 <5 MiB；运行时只加载实际使用的 schema。
- composition job 使用一次 build artifact，避免每个步骤重复安装。
- 以 lockfile hash 缓存依赖；任何 contract/source SHA 变化只失效相关 build cache。
- `concurrency.cancel-in-progress: true` 仅用于同一 PR；release workflow 禁止自动取消。
- CI 服务健康检查使用 bounded timeout，并在失败时立即收集日志，不做无限 retry。

本方案不增加生产请求链路的网络 hop；契约在构建时 vendored，版本协商只增加常量级 header 处理。

## 14. 可观测性与运营

组合 workflow summary 固定输出：

- 三仓 repository + SHA。
- contract bundle version + digest。
- runtime/lockfile versions。
- 每个阶段耗时。
- 失败所属边界：contract、shopping、catalog、kiwi、artifact、attestation。
- 生成 artifact 的 SHA-256、SBOM digest、attestation URL。

nightly 连续两次失败才创建阻断级事件，第一次标记 flaky candidate；同一 SHA 重跑成功仍保留第一次失败记录，不掩盖不稳定性。

## 15. 分阶段实施

### Phase 0：冻结基线与立即修正（1 天）

- 记录三个仓库当前 main SHA、测试命令、artifact 和契约 hash。
- 修正 CandidateAgent owner/路径漂移。
- 建立 architecture decision record 和 `portfolio.lock.json` 初版。
- 为 workflow、contracts、lockfile 设置 CODEOWNERS。

完成定义：当前三仓组合可由 manifest 重建；文档不再指向不存在路径。

### Phase 1：统一契约 bundle（2–4 天）

- 建 manifest、deterministic bundle、consumer lock、golden vectors。
- Python schema dict 改为加载 vendored JSON。
- AJV/Python parity 与 spec mirror byte-check 上 CI。
- 定义 header version negotiation，但暂不启用新版本输出。

完成定义：人工改任一副本、dialect 结果不一致或 lock 漂移都会失败。

### Phase 2：三仓 CI + composition（3–5 天）

- kiwi、catalog 建 Layer 1 CI；shopping CI 改 locked install 与 SHA pin。
- 建中央固定 SHA composition 和 nightly。
- 覆盖 shopping → catalog → kiwi → negotiation/handoff 主链。

完成定义：任意三个公开 commit SHA 可重复跑；契约变更无 Layer 2 绿灯不能合并。

### Phase 3：服务一致性与热点拆分（5–10 天，多个小 PR）

- conformance kit 覆盖两服务。
- 依次拆 app factory、route/error mapping、领域热点。
- 每个 PR 只做一个结构单元，完整回归后合并。
- 两个发布周期后评估是否值得抽极小 shared pure-functions package。

完成定义：公共行为同一套测试；热点职责清晰；没有条件分支型“大公共库”。

### Phase 4：可验证发布链（3–5 天）

- Python uv.lock、Docker locked install、Node npm ci。
- build-once、SBOM、GitHub/PyPI/npm provenance、GHCR cosign。
- protected release environment、post-publish verification、rollback drill。

完成定义：每类 artifact 都能从源码 SHA 追到 digest/SBOM/attestation，并由干净环境验证安装。

### 当前实施证据（2026-08-09）

- `contracts/manifest.json`、consumer lock、golden vectors 和固定 SHA 组合 CI 已提交。
- `contracts/conformance/python-service` 作为 dev-only 套件已接入两个 Python 服务；本地固定 lock 命令通过。
- 三仓 GitHub Actions 已固定到完整 commit SHA；新增 `portfolio-integration.yml` 作为只读、无发布权限的固定 SHA 组合门禁，两个 Python Dockerfile 使用 digest 基础镜像、`uv.lock` 和 hash 校验依赖。
- `release-rehearsal.yml` 已实现一次构建、SBOM、release manifest、keyless cosign blob 签名和 GitHub provenance attestation；新增 `portfolio-release.yml` 将同一 immutable bundle 接入 `kiwi-release` protected environment，使用 npm/PyPI Trusted Publishing OIDC 发布，并在发布后按 manifest digest 重新下载校验。
- 本轮组合验收已通过 kiwi `npm run verify`（116 个测试文件、1680 tests）；catalog 最新 profile-index leaf（`c74a66d`）后全量 pytest 480、unittest 232，`mypy` 92 个 source files 无问题，新增/改动模块 ruff 全绿（仅保留 7 个既有 S110 队列清理分支）；shopping-cli 最新 negotiation message leaf（`b76703f`）后全量 pytest 733（194 subtests）、`scripts/verify.sh` 的 unittest 572（9 skipped）+ Node 插件 7 + 额外 6 项，ruff/mypy 全绿，mypy 89 个 source files；双适配器 conformance、contract lock、release manifest/离线 rollback 也通过。`scripts/e2e-local.sh` 已由独立验收在真实 shopping-cli API 上跑通 buyer ask → merchant counter → buyer accept_nonbinding 三消息链路。
- 2026-08-10 的发布前安全批次由 claude-ds 生成并经独立验收提交 `0c2703f`：候选组合锁现在额外 fail-closed 校验中央 `contracts/kiwi-contracts.lock.json`；`portfolio-contracts.yml`、`release-rehearsal.yml`、`supply-chain-rehearsal.yml` 在 checkout 前拒绝非 40 位小写 SHA，并在组合锁检查中核对 consumer HEAD 与 `source_commit/bundle_sha256`；新增中央锁漂移和工作流引用测试。相关目标集 49 tests、lint、typecheck、候选组合锁验证和完整 `npm run verify`（1669 tests）均通过。公开 `portfolio.lock.json` 未修改。
- 只读远程预检确认三仓 `git push --dry-run origin main` 均可达（最新本地范围：kiwi `8e6ac26..6618e34`、catalog `cd943f9..c74a66d`、shopping `aaf059f..b76703f`），但没有执行真实 push；`gh workflow list` 可见组合/发布工作流且当前没有 `portfolio-integration.yml` 运行记录。GitHub `kiwi-release` environment API 返回 404（环境总数为 0），因此受保护 OIDC 发布、post-publish 下载校验和真实 rollback 仍明确阻塞；仓库 action pinning 强制开关当前为 false，但本地工作流仍全部使用完整 40 位 action commit SHA。
- catalog T8 新批次由 claude-ds 生成并提交 `59128bd`：从 1700 行 `agent_verification.py` 中抽出纯 profile-stage policy（rung 常量、failure/profile shapes、304 snapshot wrapper、ISO 时间解析、新鲜度判定）到 `services/verification_profile_policy.py`，保留 facade 兼容入口与 DB/状态机边界；新增 20 个 characterization tests。独立验收目标测试 20、全量 pytest 405、unittest 232、mypy 88 source files 通过；改动文件 ruff 除 7 个既有 S110 cleanup 例外外全绿（I001 已由 claude-ds 修复）。
- catalog T8 又完成 `bbc3359`：将 `agent_verification.py` 的纯证据降级/失败分流策略抽出到 `services/verification_degradation.py`（`highest_supported_level`、`ProfileFailurePlan`、`profile_failure_plan`），通过回调注入保留状态机合法性检查、DB 读取和持久化顺序；新增 27 个 characterization tests，修正了 expiry 严格 `<` 边界和全量迁移 fixture。独立验收目标测试 27、全量 pytest 432、unittest 232、mypy 89 source files 通过；改动文件 ruff（忽略 7 个既有 S110）全绿，两个 import I001 已由 claude-ds 修复。
- shopping-cli T9 又完成 `7c445ff`：将 `services/negotiation.py` 中无副作用的 product/stock/delivery block、最新 proposal 与 open-issues 投影抽出到 `services/negotiation_snapshot_projection.py`，facade 只保留数据库读取、权限/状态边界和 contract validation；新增 42 个 characterization tests，固定 stock bucket、时间窗口、截断、fail-closed 与 facade identity。独立验收全量 pytest 712（194 subtests）、unittest 569、改动文件 ruff（忽略既有 S110 规则）全绿、mypy 88 source files、`scripts/verify.sh`（unittest 569、Node 7、额外 6 项）均通过。
- shopping-cli T9 再完成 `b76703f`：将 `submit_decision` 中无副作用的 sender/status/structured-payload shaping 抽出到 `services/negotiation_message.py`，保留 claim、gate、SQLite 写入、审计和幂等重放顺序；新增 21 个 characterization tests，覆盖 merchant/buyer、decline/non-decline、协议版本、idempotency 和 facade identity。独立验收全量 pytest 733（194 subtests）、unittest 572、改动文件 ruff（忽略既有 S110 规则）全绿、mypy 89 source files、`scripts/verify.sh`（unittest 572、Node 7、额外 6 项）均通过；最新候选组合锁已更新为 shopping `b76703ff3d75231556f4e64a21cd1fb44abd9cc9` 并由 `verify:portfolio-lock` 独立验证。
- T6 的 `portfolio-integration.yml` 现在在固定 SHA、锁定依赖、契约锁和 conformance 之后提供 `workflow_dispatch` 专用跨进程 E2E 步骤，并设置 45 分钟 job timeout；普通 `pull_request` 不执行该长链路。Kiwi 新增 `npm run verify:portfolio-lock`（`629d9aa`）作为离线候选组合预检，已用最终本地候选三仓锚点（kiwi `6618e34e89b5dbcd63f5b7dfad08b9fb0b6eafa1`、catalog `c74a66d3da38c9f1c8c4bf43b84e1cc7a64b4e0c`、shopping `b76703ff3d75231556f4e64a21cd1fb44abd9cc9`）、manifest digest 和两个 consumer lock 独立通过；当前本地三仓质量修复提交尚未进入公开组合锁：公开 `portfolio.lock.json` 仍指向未出现在远程 main 的 `6105eff`/`d636c2c`/`cf473dd` 快照，直接对当前本地 checkout 运行 verifier 会以 `HEAD_MISMATCH` fail-closed，且三个远程 main 仍分别是 `8e6ac26`/`cd943f9`/`aaf059f`；不能在未确认远程可见前直接改为本地提交，否则固定 SHA checkout 会失败；后续应在受控推送/同步后更新 consumer SHAs，再实际 dispatch 一次组合门禁。
- 尚未关闭项是 repository 其余热点、negotiation orchestration 的剩余数据库/状态协调、GitHub 受控环境实际 dispatch 与 nightly 稳定性，以及需要 GitHub `kiwi-release` 环境、Trusted Publisher 映射和有效 GitHub 授权的真实 registry 发布后回滚演练（T12）。本轮新增 catalog `api/route_table.py` 与 `api/fastapi_routes.py`（`a724206`，格式收尾 `f8007fc`），将 1254 行 app facade 收敛为 148 行门面；新增 `services/verification_stages.py`（`d9c3852`），将纯 stage result/evidence policy 从 1756 行验证热点中移出；新增 `services/verification_queue_ledger.py`（`1d8992c`），将 7 个参数化 SQL statement helper 从 VerificationQueue ledger facade 中移出，保留锁、事务与时间边界；shopping-cli 新增同构 `api/route_table.py` 与 `api/fastapi_routes.py`（`5647260`），将 1203 行 app facade 收敛为 122 行门面；新增 `core/negotiation_contracts.py`（`e783b68`），将 schema validator、RFC3339 时间规范化和 canonical JSON 从 274 行 negotiation facade 中移出，并以 characterization tests 固定公开导出、错误文案和缓存 identity；最新 `7c445ff` 再把 snapshot 投影纯逻辑移出 negotiation facade，`b76703f` 再把 decision message projection 纯逻辑移出。此前已完成 catalog pagination/page shaping、row serialization、public views、search scoring、verification queue serialization/types、FastAPI error handler registration、request dispatch、shopping request dispatch、request-body limit middleware、FastAPI error handler registration、negotiation policy result、纯路由模板匹配器、错误 envelope/response、verification/negotiation 纯策略 helper。`scripts/rollback-drill.mjs` 与 `scripts/verify-rollback-candidate.mjs` 已完成离线/只读回滚验证。
- 本轮 repository 热点拆分（T8/T9 纯结构，catalog）：`5808df5` 新增 `agent_catalog/verification_evidence.py` 叶子模块，将六个纯 §5.5/§5.6 SQL persistence helper（`insert_profile_snapshot`/`latest_profile_snapshot`/`list_profile_snapshots`/`insert_verification`/`latest_verification`/`list_verifications`）从 `sqlite_repository.py` 热点中移出，`sqlite_repository` 全量 re-export 保持公开门面与 `CatalogRepository` 抽象映射不变，不改 API/状态机/schema/错误文案/契约。新增 `tests/test_verification_evidence.py` characterization tests 锁定 SQL 语义、事务边界（helper 不 commit）、v0.3 §7.1 的 `result="passed"` 过滤与门面 re-export。独立验收已通过目标集 72 tests、全量 pytest 354、unittest 232、ruff（改动文件）与全量 mypy 85 source files；沙箱内 HTTP 绑定限制已通过受控权限复跑确认，工作区提交已生成。
- 本轮 negotiation orchestration 热点拆分（T9 纯结构，shopping-cli）：`066a7a3` 新增 `services/negotiation_gates.py`，将 proposal facts 与 buyer non-binding gate 从 `services/negotiation.py` 移出，merchant gate 保留在 facade 以隔离跨模块私有 automation floor；保留 `_check_proposal_facts`/`_buyer_gate` 兼容入口、调用顺序、错误文案与状态机。新增 characterization tests 锁定 leaf/facade identity、库存观察一致性、报价过期、缺 proposal 和 merchant gate 边界。独立验收已通过目标集 181 tests/13 subtests、全量 pytest 670/194 subtests、`scripts/verify.sh` unittest 568（9 skipped）+ Node 7 + 额外 6 项、ruff 与全量 mypy 87 source files。
- 本轮 catalog repository 私有域拆分（T8/T9 纯结构）：`0245555` 新增 `agent_catalog/trust_observations.py`，将 §5.7 private-only 的五个参数化 SQL helper 从 `sqlite_repository.py` 移出，保持 observation kind 独立、不进入 public serializer/reputation score；新增 20 个 characterization tests。`308adf8` 再新增 `agent_catalog/catalog_audit.py`，将 catalog-scoped `append_catalog_audit` 移出并保持 payload defaults、时间戳和事务边界；新增 11 个 characterization tests。两批累计独立验收通过 catalog 全量 pytest 385、unittest 232、ruff 与 mypy 87 source files。
- 本轮 catalog 查询装配拆分（T8/T9 纯结构）：`e67716b` 新增 `agent_catalog/catalog_query.py`，将三处 list/search 入口重复的 merchant join、§8.3 排序片段、legacy cursor predicate 与 `limit+1` page sentinel 组装移出；排序片段复用 pagination 的 rank/sort-name 常量，保持 v2 cursor predicate 与 ORDER BY 同源，repository 保留连接、事务和公开入口。新增 16 个 characterization tests，覆盖 SQL 参数顺序、placeholder 数量、分页边界、排序和 LIKE 过滤；独立验收 catalog 全量 pytest 448、unittest 232、ruff（忽略 7 个既有 S110）和 mypy 90 source files 均通过。
- 本轮 catalog verification audit policy 拆分（T8/T9 纯结构）：`1f7101e` 新增 `services/verification_audit_policy.py`，将 `_finalize` 的 §23 audit event 与 §24 verified funnel 纯决策抽出为有序 side-effect plan，facade 仅执行既有 append/metric 顺序；新增策略与 facade characterization tests，覆盖 refreshed-first、commerce/verified/rejected/STALE、空 stages fallback 和公开字段边界。独立验收目标集 68、全量 pytest 469、unittest 232、ruff（忽略 7 个既有 S110）全绿、mypy 91 source files 通过。
- 本轮 catalog profile index 拆分（T8/T9 纯结构）：`c74a66d` 新增 `services/verification_profile_index.py`，将 `_index_profiles` 的 capabilities/skills 合并与 agent_card/ucp_profile endpoint 字段整形移出，facade 仅保留原顺序的三个 repository 写入调用；新增 characterization tests 覆盖空/重复列表、字段映射、输入不变性及 delegation 顺序。独立验收目标集 52、全量 pytest 480、unittest 232、ruff（忽略 7 个既有 S110）全绿、mypy 92 source files 通过。
- 本轮 release/rollback 离线验收补强：`b5fc074` 新增 `tests/release-manifest-rollback.test.ts`，以临时 fixture 实测 `verify-release-manifest.mjs` 的合法/篡改/未绑定 SHA/路径穿越 fail-closed 行为，以及 `rollback-drill.mjs` 的 previous/current symlink 激活与恢复；新增 11 tests，Kiwi 最新 `npm run verify` 通过 116 个测试文件、1680 tests、contracts/vectors/package smoke。
- claude-ds 对剩余 `VerificationService` 纯状态候选做了边界审查，确认 `_apply_*` 仅是数据库状态写入，`_stage_*` 仍承担状态机惰性求值与持久化顺序，当前没有收益足够且无行为风险的进一步纯 leaf；因此未强行拆分，保持状态机/事务边界集中。

## 16. 并行实施策略

| Lane | 工作 | 模块 | 依赖 |
| --- | --- | --- | --- |
| A | contract authority、bundle、vectors、lock | `kiwi/contracts`, `kiwi/spec` | Phase 0 |
| B | 三仓 Layer 1 CI、Action SHA policy | 三仓 `.github`, manifests/locks | Phase 0；最终接 A lock format |
| C | Python conformance kit | contracts conformance + 两仓 tests | A manifest format |
| D | release/SBOM/attestation | 三仓 release workflows、Docker/package scripts | B；正式发布前需 A + composition |
| E | 热点拆分 | 各自 service/api/repository | C green |

执行顺序：

```text
Phase 0
  ├── Lane A ───────┐
  └── Lane B ───────┼── composition gate
                    ├── Lane C ── Lane E
                    └── Lane D
```

- A 与 B 可并行，但 B 的最终 contract job 等待 A 的 lock format。
- catalog 与 shopping 的热点拆分可在不同 worktree 并行；同一仓 `api/app.py` 与 route/error 模块必须串行。
- release workflow 与普通 CI 可并行实现，但 publish 权限必须等 composition 绿灯后启用。

## 17. 实施任务

- [x] **T1（P2，human ~4h / Codex ~45min）**：建立 `contracts/manifest.json`、deterministic bundle 和 SHA verification。
  - 验证：同一 commit 连续构建的 tarball SHA-256 完全相同。
- [x] **T2（P2，human ~6h / Codex ~60min）**：迁移 CandidateAgent schema 权威源，删除失效 owner/路径，并让 catalog 加载 vendored JSON。
  - 验证：kiwi/catalog 的 valid/invalid vectors 一致。
- [x] **T3（P2，human ~1d / Codex ~90min）**：建立 contract golden corpus、AJV/Python parity 和 backward compatibility checker。
  - 验证：故意加 unknown field、收窄 enum、改变 dialect 均会失败。
- [x] **T4（P2，human ~4h / Codex ~45min）**：三个仓库加入 `contracts.lock.json` 与 verify-only CI。
  - 验证：修改 vendored schema 或 lock digest 任意一处会失败。
- [x] **T5（P2，human ~1d / Codex ~90min）**：为 kiwi、kiwi-catalog 建 CI，并硬化 shopping-cli CI。
  - 验证：full tests、package smoke、SHA-pinned Actions policy 全绿。
- [~] **T6（P2，human ~1.5d / Codex ~2h）**：建立固定 SHA 的 `portfolio-integration.yml` 确定性组合门禁，并把 `scripts/e2e-local.sh` 接入 `workflow_dispatch` 专用受控步骤；普通 PR 不启动长链路服务。
  - 验证：错误 SHA 在执行前失败；组合门禁完成 kiwi 全量测试、两仓 locked install/契约锁、Python conformance；本地真实 HTTP buyer ask → merchant counter → buyer accept_nonbinding 已通过。GitHub 受控 dispatch 和 7 天稳定窗口仍待外部执行。
- [x] **T7（P2，human ~1d / Codex ~90min）**：建立 Python service conformance adapter/cases。
  - 验证：FastAPI/fallback、auth/error/limits/idempotency/session 两仓一致。
- [~] **T8（P2，human ~3–6d / Codex ~1d）**：已完成 `agent_catalog/pagination.py`（含页边界/page shaping）、`agent_catalog/row_serialization.py`、`api/route_matching.py`、`api/error_envelope.py`、`api/request_dispatch.py`、`api/error_handlers.py`、`api/route_table.py`、`api/fastapi_routes.py`、`services/verification_helpers.py`、`services/verification_queue_serialization.py`、`services/verification_queue_types.py`、`services/verification_stages.py`、`services/verification_queue_ledger.py`、`services/verification_profile_index.py`、`services/verification_audit_policy.py`、`agent_catalog/verification_evidence.py`、`agent_catalog/trust_observations.py`、`agent_catalog/catalog_audit.py` 与 `agent_catalog/catalog_query.py` 多组无行为变更 facade 拆分；FastAPI route registration、纯 stage/evidence/profile-index/audit shaping、queue ledger SQL、verification evidence/trust/audit/query SQL 已从热点移出，repository 其余业务读写继续按小 PR 推进。
  - 验证：kiwi-catalog 全量 pytest 385、unittest 232、mypy 87 个 source files 通过，公开 facade、fallback/FastAPI 双栈、队列锁/事务/序列化、verification evidence/trust/audit 事务边界和契约锁不变；conformance、composition 需在同步后的固定 SHA 上复跑。
  - 验证：shopping-cli pytest 586（138 subtests）、verify.sh unittest 536（6 skipped）+ 插件 7、ruff/mypy 全绿；conformance、composition 仍需在同步后的固定 SHA 上复跑。
-  - 验证：shopping-cli pytest 670（194 subtests）、verify.sh unittest 568（9 skipped）+ Node 插件 7 + 额外 6 项、mypy 87 个 source files；kiwi-catalog pytest 354、unittest 232、mypy 85 个 source files；两仓改动文件 ruff 全绿（catalog 仅保留 7 个既有 S110 队列清理分支），conformance、composition 仍需在同步后的固定 SHA 上复跑。
- [~] **T9（P2，human ~3–5d / Codex ~1d）**：已完成 `core/catalog_text.py`、`core/catalog_views.py`、`core/catalog_scoring.py`、`api/route_matching.py`、`api/error_response.py`、`api/request_dispatch.py`、`api/request_limits.py`、`api/error_handlers.py`、`services/negotiation_policy_helpers.py`、`services/negotiation_policy_result.py`、`services/negotiation_snapshot.py`、`services/verification_stages.py`、`services/verification_queue_ledger.py`、`services/negotiation_gates.py`、`services/negotiation_snapshot_projection.py`、`services/negotiation_message.py` 与 `core/negotiation_contracts.py` 多组无行为变更 facade 拆分；业务 catalog、negotiation orchestration 和 repository 其余热点继续按小 PR 推进。shopping-cli 最新拆分为 `ce928cb`、`dae7cac`、`5647260`、`e783b68`、`066a7a3`、`7c445ff`、`b76703f`，catalog 最新拆分为 `99f77f8`、`a724206`、`f8007fc`、`d9c3852`、`1d8992c`、`5808df5`、`0245555`、`308adf8`、`e67716b`、`c74a66d`，保留两仓既有 app/fallback 兼容入口。
  - 验证：shopping-cli pytest 670（194 subtests）、verify.sh unittest 568（9 skipped）+ Node 插件 7 + 额外 6 项、mypy 87 个 source files；kiwi-catalog pytest 385、unittest 232、mypy 87 个 source files；两仓改动文件 ruff 全绿（catalog 仅保留 7 个既有 S110 队列清理分支），conformance、composition 仍需在同步后的固定 SHA 上复跑。
  - 验证：shopping-cli pytest 670（194 subtests）、verify.sh unittest 568（9 skipped）+ Node 插件 7 + 额外 6 项、mypy 87 个 source files；kiwi-catalog pytest 354、unittest 232、mypy 85 个 source files；两仓改动文件 ruff 全绿（catalog 仅保留 7 个既有 S110 队列清理分支），conformance、composition 仍需在同步后的固定 SHA 上复跑。
  - 验证：shopping-cli ruff/mypy 全绿；conformance、composition 仍需在同步后的固定 SHA 上复跑。
  - 最新独立验收：catalog 查询装配批次后 pytest 448、unittest 232、mypy 90 source files；shopping 决策消息投影批次后 pytest 733（194 subtests）、unittest 572、mypy 89 source files，两个仓改动文件 ruff 全绿，`scripts/verify.sh` 的 Node 7 + 额外 6 项通过。
- [x] **T10（P2，human ~1d / Codex ~90min）**：两个 Python 仓库引入 `uv.lock`，Docker/CI 改 locked install；kiwi 强制 `npm ci`。
  - 验证：lock stale、依赖现场漂移和未固定 base image 均失败。
- [~] **T11（P2，human ~1.5d / Codex ~2h）**：已建立 build-once、SBOM、keyless cosign blob 签名、GitHub provenance attestation，以及 `portfolio-release.yml` 受保护 OIDC 发布工作流。代码侧已完成；真实 npm/PyPI publish 仍需人工配置 `kiwi-release` environment、Trusted Publisher 映射、版本 bump 和有效 GitHub 授权。
  - 验证：dry-run 只生成一次构建物并上传签名/证书；publish job 只下载 immutable bundle，权限不含长期 registry token 或 `packages: write`。
- [~] **T12（P2，human ~4h / Codex ~45min）**：已加入 `scripts/verify-release-manifest.mjs`、`scripts/verify-registry-downloads.mjs`、`scripts/verify-rollback-candidate.mjs` 与 `scripts/rollback-drill.mjs`，并新增 `tests/release-manifest-rollback.test.ts` 覆盖 manifest/rollback 离线 fail-closed 行为；离线“上一版本 → 回滚 → 当前版本恢复”及只读候选 digest 校验已通过，真实 registry release rollback 仍需受保护环境和上一版本 manifest。
  - 验证：发布后按 manifest 重新下载 npm/PyPI artifact 并 fail-closed 比对 digest；回滚验证不执行删除或 unpublish，实际生产回滚通过重新选择已验证的上一版本 digest 完成。

## 18. 总体验收标准

以下全部满足才关闭本组 P2：

- [x] 机器契约只有 `kiwi/contracts` 一个权威源，所有副本可由工具重建。
- [x] 三仓 contract lock 固定 bundle version、source SHA 与 digest。
- [~] strict schema 的新增字段已有兼容性/golden 校验；消费者优先 rollout 与 HTTP 版本协商仍需独立落地。
- [x] 三仓有独立 merge gate，且 Action 全部 pin 完整 SHA。
- [ ] 固定 SHA composition 与 nightly 均稳定通过 7 天。
- [x] Python service conformance 在两个服务上通过。
- [~] 热点拆分未改变 API/状态机，测试总量不下降（catalog app facade、route table、FastAPI adapter、verification evidence/trust/audit/query persistence、profile-index/audit policy、shopping negotiation gates/snapshot/message projection 已验证；repository orchestration 与剩余业务热点仍需后续小 PR）。
- [x] Python 使用 `uv.lock`，Node 使用 `npm ci`，容器使用 locked deps 与 base digest。
- [~] npm/PyPI/OCI/contracts bundle 的构建、SBOM、来源证明和 keyless bundle 签名链路已具备；真实 registry 发布与下载验证待 `kiwi-release` 受保护环境批准。
- [~] 用户可以从干净环境验证 artifact identity 与安装结果（本地 package smoke、registry verifier 和离线 manifest 已通过；公共 registry 下载验证待受保护环境）。
- [~] 完成一次按 digest 的回滚演练（离线上一版本→回滚→恢复、只读 rollback candidate 校验已通过；真实 registry digest 仍待受控环境）。

## 19. NOT in scope

- **Monorepo 迁移**：会扩大构建、权限和发布耦合，当前问题可在多仓治理下解决。
- **共享 DB/session 运行时**：两产品的迁移链、时间语义和权限处理已经分叉，抽取收益低于 blast radius。
- **统一全部 JSON Schema dialect**：属于 contract major migration，不能混在底盘治理中。
- **GitHub App 自动跨仓 dispatch**：先用无长期密钥的手动固定 SHA + nightly；出现真实频率瓶颈后再做。
- **自建签名 CA/KMS**：keyless OIDC 足以覆盖公开发布，避免长期密钥运维。
- **业务 API/UX 变更**：本设计只改变工程治理和发布链路。

## 20. 备选方案与取舍

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 新建第四个 `kiwi-contracts` repo | 不采用 | `kiwi/spec` 已在 2026-08-09 并入 kiwi；再拆会增加 owner 和同步面 |
| 把两个 Python 服务合并为一个 repo/package | 不采用 | 产品数据边界不同，组合 CI 已能解决协同问题 |
| 立即抽完整 `kiwi-service-core` | 不采用 | 同名模块已有领域分叉；先共享 conformance 更可逆 |
| 每个 PR 自动跨仓调用带 PAT workflow | 不采用 | 长期 token 与 untrusted PR 组合风险高；固定 SHA 手动门足够起步 |
| 只生成 SBOM，不签名/attest | 不采用 | SBOM 无法单独证明属于哪个 artifact 和 workflow |
| 只签名，不锁依赖 | 不采用 | 可证明来源，但无法重现解析结果，也无法解释 artifact 内容 |

## 21. 参考标准与官方资料

- [GitHub Artifact Attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)：为二进制、容器及 SPDX/CycloneDX SBOM 建立来源证明并支持 `gh` 验证。
- [GitHub Actions Secure Use](https://docs.github.com/en/actions/reference/security/secure-use)：最小权限、第三方 Action 风险、完整 SHA pin 与 Dependabot 更新。
- [npm Provenance](https://docs.npmjs.com/generating-provenance-statements/)：GitHub-hosted runner、OIDC/provenance 和 registry 验证路径。
- [PyPI Producing Attestations](https://docs.pypi.org/attestations/producing-attestations/)：Trusted Publisher 与官方 publish action 默认 attestation。
- [uv Locking and Syncing](https://docs.astral.sh/uv/concepts/projects/sync/)：`uv.lock`、`--locked`、精确同步以及 CycloneDX/pylock 导出。
- [Sigstore Blob Signing](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/) 与 [Signature Verification](https://docs.sigstore.dev/cosign/verifying/verify/)：keyless bundle、identity/issuer 限制和透明日志验证。
- [SLSA v1.2](https://slsa.dev/spec/v1.2/)：按阶段提高 build provenance 与构建平台保障等级。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| Eng Review | `plan-eng-review` | Architecture, code quality, tests, performance | 1 | CLEAR FOR IMPLEMENTATION | 4 workstreams, 12 tasks, 0 silent critical gaps |
| CEO Review | `plan-ceo-review` | Product scope | 0 | Not required | 底盘治理，不改变产品方向 |
| Design Review | `plan-design-review` | UI/UX | 0 | Not required | 无 UI 范围 |

**VERDICT:** ENG CLEARED，按 Phase 0 → 4 分阶段实施；每阶段以现实 CI/artifact 证据关闭。

NO UNRESOLVED DECISIONS
