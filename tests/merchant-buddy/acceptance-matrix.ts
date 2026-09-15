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
 * Kiwi Merchant Buddy F01–F30 验收矩阵（V2 §3 功能清单冻结；阶段一）。
 *
 * 每条记录：编号、标题、类别（A/B/C 沿用 V2 §3）、能力状态（Kiwi 侧实现度）、
 * Buddy 接线状态、证据（真实测试文件）。矩阵本身可测试：编号缺失/重复、
 * 状态非法、证据文件不存在都会让 acceptance-matrix.test.ts 失败——
 * 禁止删除条目换取「全量覆盖」（V2 §10）。
 */

export type MatrixCategory = "A" | "B" | "C";
/** 能力状态：Kiwi 侧实现度（covered=有实现有测试；partial=受限/部分；missing=无）。 */
export type CapabilityStatus = "covered" | "partial" | "missing";
/** Buddy 接线状态：wired=Buddy/MCP 入口可用；partial=部分接入；pending=未接。 */
export type BuddyStatus = "wired" | "partial" | "pending";

export interface MatrixEntry {
  id: string;
  title: string;
  category: MatrixCategory;
  capability: CapabilityStatus;
  buddy: BuddyStatus;
  /** 证据：真实存在的测试文件（相对仓库根）。 */
  evidence: string[];
  note?: string;
}

export const ACCEPTANCE_MATRIX: MatrixEntry[] = [
  {
    id: "F01",
    title: "开店向导（merchant init）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    evidence: ["tests/product-init.test.ts"],
  },
  {
    id: "F02",
    title: "启动接待服务（merchant start / agent serve）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    evidence: ["tests/supervisor.test.ts"],
  },
  {
    id: "F03",
    title: "域名接入向导（setup-public / up）",
    category: "A",
    capability: "covered",
    buddy: "partial",
    evidence: ["tests/product-merchant.test.ts", "tests/merchant-buddy/stage4-acceptance.test.ts"],
    note: "阶段四：buildDomainOnboardingChecklist 结构化检查单（公开投影分离 + DNS/TLS 人工项）",
  },
  {
    id: "F04",
    title: "发布与 CSV 导入（publish）",
    category: "A",
    capability: "covered",
    buddy: "wired",
    evidence: ["tests/product-merchant.test.ts", "tests/merchant-buddy/stage4-acceptance.test.ts"],
    note: "阶段四：CSV 导入 prepare 闭环 + 幂等 + 逐行回执 + 撤回（kiwi_merchant_prepare_products_import/withdraw）",
  },
  {
    id: "F05",
    title: "商品列表与详情读取",
    category: "A",
    capability: "covered",
    buddy: "wired",
    evidence: ["tests/merchant-workbench-service.test.ts", "tests/merchant-mcp.test.ts"],
  },
  {
    id: "F06",
    title: "商品新建/修改/草稿（审批后执行）",
    category: "A",
    capability: "covered",
    buddy: "wired",
    evidence: ["tests/merchant-pack.test.ts", "tests/merchant-commands.test.ts"],
    note: "阶段三：prepare→确认→执行闭环（execute_approved/reject_candidate）已落地",
  },
  {
    id: "F07",
    title: "库存快照与变更审批",
    category: "A",
    capability: "covered",
    buddy: "wired",
    evidence: ["tests/merchant-client-stock.test.ts", "tests/merchant-mcp.test.ts"],
  },
  {
    id: "F08",
    title: "上下架（销售状态变更）",
    category: "B",
    capability: "partial",
    buddy: "wired",
    evidence: ["tests/merchant-capability-probe.test.ts", "tests/merchant-commands.test.ts"],
    note: "语义「销售状态」已接入写闭环（prepare_listing_change）；上游 shopping-cli 2.x 无端点 → 能力缺失时 fail-closed「不可得」（P0-3）",
  },
  {
    id: "F09",
    title: "A2A 自动接待（RFQ/offer/counter/conditional）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    evidence: [
      "tests/merchant-handler-accept-validation.test.ts",
      "tests/merchant-delivery-terms.test.ts",
    ],
    note: "工作台查看过程（Buddy 展示）留阶段二",
  },
  {
    id: "F10",
    title: "澄清/终止（clarification/withdraw/decline/cancel）",
    category: "A",
    capability: "partial",
    buddy: "pending",
    evidence: ["tests/merchant-handler-accept-validation.test.ts"],
    note: "商家主动干预命令未实现（不假称已有）",
  },
  {
    id: "F11",
    title: "非绑定协议查看（agreement artifact）",
    category: "A",
    capability: "covered",
    buddy: "partial",
    evidence: ["tests/merchant-handler-accept-validation.test.ts", "tests/merchant-mcp.test.ts"],
    note: "MCP 经 list_a2a_negotiations 可见 agreement 标记；详情视图留阶段二",
  },
  {
    id: "F12",
    title: "磋商列表与状态追溯",
    category: "A",
    capability: "covered",
    buddy: "wired",
    evidence: ["tests/merchant-workbench-service.test.ts", "tests/merchant-mcp.test.ts"],
  },
  {
    id: "F13",
    title: "shopping-cli 会话轨（snapshot/claim/decision）",
    category: "A",
    capability: "partial",
    buddy: "pending",
    evidence: ["tests/agent-consultation.test.ts"],
    note: "两轨统一列表（source_protocol）留阶段二",
  },
  {
    id: "F14",
    title: "人工审核队列与处理",
    category: "B",
    capability: "partial",
    buddy: "partial",
    evidence: ["tests/merchant-commands.test.ts", "tests/merchant-core.test.ts"],
    note: "两轨路由守卫已落地：shopping 轨经 prepare_review_resolve 走写闭环；A2A 轨 fail-closed「不可得」（绝不跨轨调 resolve-review）",
  },
  {
    id: "F15",
    title: "审批候选（pending/approve/reject/过期）",
    category: "A",
    capability: "covered",
    buddy: "partial",
    evidence: ["tests/merchant-workbench-service.test.ts"],
    note: "MCP 进程内批准执行闭环已测；Buddy 确认界面留阶段三",
  },
  {
    id: "F16",
    title: "操作授权模式（manual/supervised/autopilot）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    evidence: ["tests/merchant-pack.test.ts"],
  },
  {
    id: "F17",
    title: "策略配置查看与变更（MerchantPolicy）",
    category: "A",
    capability: "partial",
    buddy: "wired",
    evidence: ["tests/profile.test.ts", "tests/merchant-commands.test.ts"],
    note: "阶段三：prepare_policy_change 走写闭环，执行器写覆盖层热生效；硬策略（私有底价）执行器强制",
  },
  {
    id: "F18",
    title: "运营统计（merchant stats，UTC 口径）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    evidence: ["tests/merchant-stats.test.ts"],
  },
  {
    id: "F19",
    title: "经营分析（intelligence 摘要/指标/健康/摘要/待审批）",
    category: "A",
    capability: "covered",
    buddy: "wired",
    evidence: ["tests/merchant-intelligence.test.ts", "tests/merchant-digest-terms.test.ts"],
  },
  {
    id: "F20",
    title: "七类展示组件",
    category: "A",
    capability: "covered",
    buddy: "wired",
    evidence: ["tests/merchant-presentation.test.ts", "tests/merchant-resources.test.ts"],
    note: "已映射 MCP 资源（JSON + 文本降级双 content）；MCP Apps 嵌入形态待平台预览验证",
  },
  {
    id: "F21",
    title: "六个商家 Skill",
    category: "A",
    capability: "covered",
    buddy: "pending",
    evidence: ["tests/merchant-skills.test.ts"],
    note: "Buddy 适配新工具名留阶段二",
  },
  {
    id: "F22",
    title: "记忆治理（remember/forget/correct/confirm）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    evidence: ["tests/agent-memory.test.ts", "tests/merchant-buddy/stage2-acceptance.test.ts"],
    note: "远程场景不挂记忆 MCP 工具（人员授权边界）；记忆工具接入留阶段二后续",
  },
  {
    id: "F23",
    title: "私密阈值面板（PrivateVault）",
    category: "A",
    capability: "partial",
    buddy: "pending",
    evidence: [
      "tests/agent-memory.test.ts",
      "tests/merchant-core.test.ts",
      "tests/merchant-buddy/stage2-acceptance.test.ts",
    ],
    note: "私密数值不进任何工具结果与资源（已测）；readPrivateThresholds 管理面接缝带读取审计；私密面板页面留 merchant-admin",
  },
  {
    id: "F24",
    title: "profile/模型配置与会话恢复",
    category: "A",
    capability: "partial",
    buddy: "pending",
    evidence: ["tests/profile.test.ts"],
    note: "Buddy 侧仅商家 profile；禁止切 buyer（阶段二验收）",
  },
  {
    id: "F25",
    title: "网络身份/注册/发现检查",
    category: "A",
    capability: "covered",
    buddy: "partial",
    evidence: ["tests/catalog-register.test.ts", "tests/merchant-buddy/stage4-acceptance.test.ts"],
    note: "阶段四：checkNetworkRegistration 结构化注册检查（失效可检测）；Buddy 入口展示留阶段五",
  },
  {
    id: "F26",
    title: "Ledger/幂等/相位恢复",
    category: "A",
    capability: "covered",
    buddy: "pending",
    evidence: ["tests/ledger.test.ts", "tests/idempotency.test.ts"],
  },
  {
    id: "F27",
    title: "实例启停/日志/健康（runtime 管理）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    evidence: ["tests/merchant-runtime.test.ts", "tests/supervisor.test.ts"],
    note: "src/merchant-runtime/（manager/health/jobs）阶段一已落地",
  },
  {
    id: "F28",
    title: "listings/status/doctor 结构化服务",
    category: "C",
    capability: "partial",
    buddy: "pending",
    evidence: ["tests/merchant-runtime.test.ts"],
    note: "实例 status/health 由 merchant-runtime 落地（runtime status|health）；listings 与 merchant doctor 的结构化服务仍 pending",
  },
  {
    id: "F29",
    title: "微信通道与旧入口兼容",
    category: "A",
    capability: "partial",
    buddy: "partial",
    evidence: ["tests/weixin-cli.test.ts", "tests/merchant-buddy/stage4-acceptance.test.ts"],
    note: "阶段四：getWeixinStatus 只读接缝（脱敏；无事件存储明确「不可得」）；绑定/撤销操作留后续",
  },
  {
    id: "F30",
    title: "受限 decision backend（不作为生产定价权威）",
    category: "A",
    capability: "partial",
    buddy: "pending",
    evidence: ["tests/merchant-decision-backend.test.ts"],
  },
];
