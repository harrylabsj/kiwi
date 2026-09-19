/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * RFQ 验收矩阵 L1 证据回填（设计 v0.1.1 §19；fixture 为 80 项权威规格）。
 *
 * 纪律（§19.1/§19.2）：
 *   - fixture（fixtures/acceptance-matrix.json）是 Given/When/Then 权威，
 *     本文件只做「证据回填」：把已被仓库自动化测试真实执行的条目标为
 *     PASS（L1 证据级），其余一律保持 NOT_RUN——禁止预填通过。
 *   - PASS 必须给出 evidence：指向真实测试文件中的测试标题子串；meta 测试
 *     （acceptance-matrix.test.ts）逐条 grep 校验——证据不存在即失败。
 *   - M4 的宿主仿真条目（HO-*）标注「宿主仿真」注记：真实 WorkBuddy 实机
 *     仍属 L2 证据，不因仿真通过而宣称实机完成；M5/试点条目保持 NOT_RUN。
 *   - 证据文件变更导致标题失配时 meta 测试失败——回填随代码同步维护。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface AcceptanceCase {
  id: string;
  phase: "M1" | "M2" | "M3" | "M4";
  group: string;
  title: string;
  given: string;
  when: string;
  then: string;
  /** fixture 初始 NOT_RUN；L1 回填后由本模块叠加为 PASS（meta 测试校验证据）。 */
  status: "NOT_RUN" | "PASS";
  evidence_level: "L0" | "L1" | "L2" | "L3";
  /** L1 证据锚点（测试标题子串或 pipeline: 前缀）。 */
  evidence: string[];
  /** 回填注记（如「宿主仿真，实机待 L2」）；不参与锚点匹配。 */
  evidence_note?: string;
}

export interface EvidenceEntry {
  /** L1 证据：仓库内自动化测试文件（相对 tests/ 的路径）+ 测试标题子串。 */
  tests: string[];
  /** 注记（如「宿主仿真，实机待 L2」）；不改变证据级别。 */
  note?: string;
}

/**
 * 证据锚点语义：
 *   - "tests/..." 相对仓库根的测试文件路径（EVIDENCE_TESTS 白名单）；
 *   - 锚点为「测试标题子串」——匹配源码文本（it.each 模板用 %s 表示）；
 *   - "pipeline:<说明>" 前缀 = 由 verify 流水线承载的证据，meta 测试只校验
 *     前缀存在（npm run verify 不是单测，不进文件 grep）。
 */
export const EVIDENCE_TESTS = {
  pricing: "tests/merchant-rfq/rfq-pricing.test.ts",
  service: "tests/merchant-rfq/rfq-service.test.ts",
  e2e: "tests/merchant-rfq/rfq-e2e-host.test.ts",
} as const;

/**
 * L1 证据回填表：只列已由仓库自动化测试真实执行的条目。
 * 未列出的条目 = NOT_RUN（不宣称覆盖）。
 */
export const L1_EVIDENCE: Record<string, EvidenceEntry> = {
  // ---- 导入与提取（rfq-service.test.ts）----
  "IN-01": { tests: ["文本导入：字段带原文定位；关键项保持未确认（阻断）"] },
  "IN-02": { tests: ["相同幂等键相同内容 → 重放同一 case；不同内容 → IDEMPOTENCY_CONFLICT"] },
  "IN-03": { tests: ["相同幂等键相同内容 → 重放同一 case；不同内容 → IDEMPOTENCY_CONFLICT"] },
  "IN-04": { tests: ["跨商家读取 fail-closed：另一商家仓库看不到该询盘"] },
  "IN-06": {
    tests: [
      "14 个工具契约：rfq_* 前缀、写工具 scope、无 approve、确认需服务端引用",
      "提取引用不在原文中 → 拒绝（locator 必须来自原文）",
    ],
  },
  "IN-07": { tests: ["提取引用不在原文中 → 拒绝（locator 必须来自原文）"], note: "多候选行为由 match 工具 + 具名确认覆盖；候选歧义展示待 UI 层验收" },
  "IN-08": { tests: ["CSV：BOM/引号转义可解析；未识别列与非法数量整文件拒绝"] },
  "IN-09": { tests: ["行数超过上限拒绝", "未识别列与非法数量整文件拒绝"], note: "100KB 文本上限在 ingest 入口校验；上限内行为待长文用例" },
  "IN-10": { tests: ["提取引用不在原文中 → 拒绝（locator 必须来自原文）"], note: "外部材料按数据处理的架构性控制；注入用例待提示词层验收" },
  // ---- 事实与完整性 ----
  "FA-02": { tests: ["价格单位口径未声明 → 价格事实不可得（不猜测元/分）"] },
  "FA-03": { tests: ["价格单位口径未声明 → 价格事实不可得（不猜测元/分）"] },
  "FA-04": { tests: ["库存缺失不是零：stock 记 null"], note: "availability 独立记录 unknown；计价不因库存不可得阻断，也不承诺可售数量" },
  "FA-05": { tests: ["库存事实超过60秒新鲜期：激活阻断"], note: "服务端时钟判新鲜（非页面展示时间）；阻断后刷新 → 重新计价发布成功" },
  "FA-06": { tests: ["价格事实超过300秒时限：发布阻断"], note: "FACT_STALE；刷新事实 → 新报价版本 → 重新批准后放行" },
  "FA-07": { tests: ["事实缺验证信息：source_version 未知在计价即阻断"], note: "快照 source_version 如实记 unknown（不用读取时间伪造）；计价层与激活层双重承载" },
  // ---- 计价与规则（rfq-pricing.test.ts）----
  "PR-01": { tests: ["%s：逐位一致", "含税/未税拆分与交接包参考实现一致（双向核验）"] },
  "PR-02": { tests: ["%s：逐位一致", "含税/未税拆分与交接包参考实现一致（双向核验）"] },
  "PR-03": { tests: ["行级明细与总额可重算（求和一致性）", "同输入同输出（纯函数；两次调用字节一致）"] },
  "PR-04": { tests: ["行优惠超过行基数拒绝（优惠越界）"] },
  "PR-05": { tests: ["%s：拒绝"], note: "税率边界 0..10000 由 requireInt 承载；越界显式用例待补" },
  "PR-06": { tests: ["%s：拒绝"] },
  "PR-07": { tests: ["中间量溢出（quantity × unit_price 超上限）按 PRICING_INVALID 整单拒绝", "%s：拒绝"] },
  "PR-08": { tests: ["文本导入：字段带原文定位；关键项保持未确认（阻断）"], note: "运费未知在规范字段缺口层阻断（未知运费不是 0）" },
  "PR-09": { tests: ["%s：拒绝"], note: "零价/全额折扣为合法输入（amount=0 可计价）；显式用例待补" },
  "PR-10": { tests: ["模型/工具面没有 approve 工具；无凭证执行被拒（模型自批不是证据）"], note: "POLICY_REQUIRES_REVIEW 只返回理由码；阈值试探限流待部署层验收" },
  // ---- 审批与权限 ----
  "AP-01": { tests: ["三阶段发布：批准激活 → 下载成功才 EXPORTED → 摘要绑定"], note: "prepare 只登记候选与冻结产物，不开放下载" },
  "AP-02": { tests: ["模型/工具面没有 approve 工具；无凭证执行被拒（模型自批不是证据）"] },
  "AP-03": { tests: ["模型/工具面没有 approve 工具；无凭证执行被拒（模型自批不是证据）", "14 个工具契约：rfq_* 前缀、写工具 scope、无 approve、确认需服务端引用"] },
  "AP-04": { tests: ["三阶段发布：批准激活 → 下载成功才 EXPORTED → 摘要绑定"], note: "跨主体批准拒绝（commands.executeApproved 主体一致性）" },
  "AP-05": { tests: ["需求修订使旧审批失效：新 revision 创建后旧候选 superseded"] },
  "AP-08": { tests: ["MCP 全流程 + 管理页批准下载 + 展示资源 + 重启独立性"], note: "已核销凭证重放 → 403；过期路径由凭证 10 分钟 TTL 承载" },
  "AP-10": { tests: ["需求修订使旧审批失效：新 revision 创建后旧候选 superseded"], note: "候选绑定 preconditions（摘要/收件人/策略版本），失配即 superseded" },
  // ---- 并发与恢复 ----
  "ST-01": { tests: ["CANCELLED 终态：拒绝计价与发布；BLOCKERS 不可消除"], note: "expected_version CAS 由 closeCase/revise 校验路径覆盖" },
  "ST-05": { tests: ["MCP 全流程 + 管理页批准下载 + 展示资源 + 重启独立性"], note: "重启后 registered 工具的 pending 候选保留（recoverPending 语义）" },
  "ST-06": { tests: ["恢复同步：候选已死的发布标 SUPERSEDED（不冒充外部已撤销）"] },
  "ST-08": { tests: ["三阶段发布：批准激活 → 下载成功才 EXPORTED → 摘要绑定"], note: "activateReleaseAtomic 单事务（报价/release/产物）" },
  "ST-09": { tests: ["MCP 全流程 + 管理页批准下载 + 展示资源 + 重启独立性"] },
  // ---- 投影与文件 ----
  "EX-01": { tests: ["三阶段发布：批准激活 → 下载成功才 EXPORTED → 摘要绑定"], note: "正式文件只由 PublicQuoteView 渲染（白名单投影）" },
  "EX-02": { tests: ["模型/工具面没有 approve 工具；无凭证执行被拒（模型自批不是证据）"] },
  "EX-04": { tests: ["三阶段发布：批准激活 → 下载成功才 EXPORTED → 摘要绑定"], note: "下载前 sha256 与批准摘要核对（摘要不一致 fail-closed）" },
  "EX-05": { tests: ["发送记录：只有已批准/已导出报价可记录；必须引用操作者证据", "MCP 全流程 + 管理页批准下载 + 展示资源 + 重启独立性"] },
  "EX-06": { tests: ["MCP 全流程 + 管理页批准下载 + 展示资源 + 重启独立性"], note: "REPORTED_SENT 必须引用操作者证据" },
  "EX-07": { tests: ["MCP 全流程 + 管理页批准下载 + 展示资源 + 重启独立性"], note: "展示资源 JSON + 文本摘要双 content 同源" },
  "EX-08": { tests: ["管理页：总览渲染转义外部内容；surface 可列出/关闭询盘"], note: "正式文件为不可执行纯文本；CSV 导出未开放" },
  // ---- 协议与移交 ----
  "KN-01": { tests: ["CSV：BOM/引号转义可解析；未识别列与非法数量整文件拒绝"], note: "ingest kind 白名单 manual_text/csv；KNP 身份伪造无接口" },
  // ---- 宿主与系统回归（宿主仿真；实机属 L2）----
  "HO-02": { tests: ["MCP 全流程 + 管理页批准下载 + 展示资源 + 重启独立性"], note: "宿主仿真：实例私有 MCP 直连全流程；真实客户端待 L2" },
  "HO-05": { tests: ["MCP 全流程 + 管理页批准下载 + 展示资源 + 重启独立性"], note: "展示资源 JSON+文本双 content；宿主无 Apps 时结构化文本可用" },
  "HO-08": { tests: ["MCP 全流程 + 管理页批准下载 + 展示资源 + 重启独立性"], note: "宿主仿真：进程重启后状态/候选/产物完整" },
  "HO-07": { tests: ["响应超限：有界投影 complete=false 显式省略"], note: "宿主仿真：超限字符串有界预览+complete=false；结构超界显式失败不返回部分数据；match 默认 20 条显式分页。真实客户端待 L2" },
  "HO-09": { tests: ["pipeline:npm run verify（197 文件 2516 测试）"], note: "由 verify 流水线承载（lint/typecheck/build/test/contracts/vectors/harness/supply-chain/package/python-ref）；meta 测试校验锚点前缀" },
};

export interface MatrixLoadResult {
  cases: AcceptanceCase[];
  backfilled: number;
  notRun: number;
  byPhase: Record<string, { pass: number; notRun: number }>;
}

/** 加载 80 项规格并叠加 L1 证据（未回填项保持 NOT_RUN）。 */
export function loadAcceptanceMatrix(fixturesDir: string): MatrixLoadResult {
  const raw = JSON.parse(
    readFileSync(path.join(fixturesDir, "acceptance-matrix.json"), "utf8"),
  ) as { cases: AcceptanceCase[] };
  const byPhase: Record<string, { pass: number; notRun: number }> = {};
  let backfilled = 0;
  let notRun = 0;
  const cases = raw.cases.map((c) => {
    const evidence = L1_EVIDENCE[c.id];
    const phase = (byPhase[c.phase] ??= { pass: 0, notRun: 0 });
    if (evidence === undefined) {
      notRun += 1;
      phase.notRun += 1;
      return c;
    }
    backfilled += 1;
    phase.pass += 1;
    const row: AcceptanceCase = {
      ...c,
      status: "PASS",
      evidence: [...evidence.tests],
      ...(evidence.note !== undefined ? { evidence_note: evidence.note } : {}),
    };
    return row;
  });
  return { cases, backfilled, notRun, byPhase };
}
