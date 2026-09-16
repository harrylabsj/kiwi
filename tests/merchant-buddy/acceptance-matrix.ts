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
 * Kiwi Merchant Buddy F01–F30 验收矩阵（V2 §3 功能清单冻结；BUG-08 修订）。
 *
 * 每条记录：编号、标题、类别（A/B/C 沿用 V2 §3）、能力状态（Kiwi 侧实现度）、
 * Buddy 接线状态、V2 发布范围、证据（真实测试文件）、Buddy/MCP 到达路径。
 * 矩阵本身可测试：编号缺失/重复、状态非法、证据文件不存在、承诺范围语义
 * 违反都会让 acceptance-matrix.test.ts 失败——禁止删除条目或缩小承诺范围
 * 换取「全量覆盖」（V2 §10）。
 *
 * BUG-08 修订要点（此前问题：只有 buddy 状态 + 测试只卡最低数量阈值，
 * 15 pending / 6 partial 也能宣称"全量完成"）：
 *   - v2Scope 明确每条目的 V2 发布范围：committed = 本版本承诺交付（必须
 *     wired/partial）；deferred = 明确延后（不得宣称 partial/wired）；
 *   - wired 条目必须声明 Buddy/MCP 到达路径（reach）——mcpTools 逐个与真实
 *     MCP 注册表核对，不是"底层测试文件存在"就算到达；
 *   - partial 必须附受限产品说明（note），不计为完整交付。
 */

export type MatrixCategory = "A" | "B" | "C";
/** 能力状态：Kiwi 侧实现度（covered=有实现有测试；partial=受限/部分；missing=无）。 */
export type CapabilityStatus = "covered" | "partial" | "missing";
/** Buddy 接线状态：wired=Buddy/MCP 入口可用；partial=部分接入；pending=未接。 */
export type BuddyStatus = "wired" | "partial" | "pending";
/** V2 发布范围：committed = 本版本承诺交付；deferred = 明确延后（不宣称交付）。 */
export type V2Scope = "committed" | "deferred";

/** Buddy/MCP 到达路径（wired 必填至少一项）。 */
export interface ReachPath {
  /** 经 MCP 工具到达（工具名必须存在于真实注册表，测试逐个核对）。 */
  mcpTools?: string[];
  /** 经 MCP 资源到达（presentation → resources）。 */
  mcpResources?: boolean;
  /** 经商家管理确认页到达（/admin/pending + 一次性确认凭证；BUG-02 后批准/拒绝不在 MCP 注册表）。 */
  adminPage?: boolean;
  /** 经 CLI 命令到达。 */
  cli?: string[];
}

export interface MatrixEntry {
  id: string;
  title: string;
  category: MatrixCategory;
  capability: CapabilityStatus;
  buddy: BuddyStatus;
  /** V2 发布范围（BUG-08）。 */
  v2Scope: V2Scope;
  /** 证据：真实存在的测试文件（相对仓库根）。 */
  evidence: string[];
  /** Buddy/MCP 到达路径（wired 必填）。 */
  reach?: ReachPath;
  /** 受限说明（partial 必填）或补充口径。 */
  note?: string;
}

export const ACCEPTANCE_MATRIX: MatrixEntry[] = [
  {
    id: "F01",
    title: "开店向导（merchant init）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/product-init.test.ts"],
    note: "能力已在 CLI（merchant init）覆盖；Buddy 接线延后，不宣称交付",
  },
  {
    id: "F02",
    title: "启动接待服务（merchant start / agent serve）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/supervisor.test.ts"],
    note: "能力已在 CLI（merchant start / runtime start）覆盖；Buddy 接线延后",
  },
  {
    id: "F03",
    title: "域名接入向导（setup-public / up）",
    category: "A",
    capability: "covered",
    buddy: "partial",
    v2Scope: "committed",
    evidence: ["tests/product-merchant.test.ts", "tests/merchant-buddy/stage4-acceptance.test.ts"],
    note: "受限交付：buildDomainOnboardingChecklist 结构化检查单（公开投影分离 + DNS/TLS 人工项）；Buddy 向导式 UI 延后",
  },
  {
    id: "F04",
    title: "发布与 CSV 导入（publish）",
    category: "A",
    capability: "covered",
    buddy: "wired",
    v2Scope: "committed",
    evidence: ["tests/product-merchant.test.ts", "tests/merchant-buddy/stage4-acceptance.test.ts"],
    reach: {
      mcpTools: [
        "kiwi_merchant_prepare_products_import",
        "kiwi_merchant_prepare_products_withdraw",
        "kiwi_merchant_get_operation",
      ],
    },
    note: "CSV 导入 prepare 闭环 + 幂等 + 逐行回执 + 撤回",
  },
  {
    id: "F05",
    title: "商品列表与详情读取",
    category: "A",
    capability: "covered",
    buddy: "wired",
    v2Scope: "committed",
    evidence: ["tests/merchant-workbench-service.test.ts", "tests/merchant-mcp.test.ts"],
    reach: { mcpTools: ["kiwi_merchant_list_products", "kiwi_merchant_get_product"] },
  },
  {
    id: "F06",
    title: "商品新建/修改/草稿（审批后执行）",
    category: "A",
    capability: "covered",
    buddy: "wired",
    v2Scope: "committed",
    evidence: [
      "tests/merchant-pack.test.ts",
      "tests/merchant-commands.test.ts",
      "tests/merchant-admin-security.test.ts",
    ],
    reach: {
      mcpTools: ["kiwi_merchant_prepare_product_change", "kiwi_merchant_prepare_product_create"],
      adminPage: true,
    },
    note: "prepare→管理确认页→执行闭环（一次性确认凭证；execute/reject 不进 MCP 注册表）",
  },
  {
    id: "F07",
    title: "库存快照与变更审批",
    category: "A",
    capability: "covered",
    buddy: "wired",
    v2Scope: "committed",
    evidence: ["tests/merchant-client-stock.test.ts", "tests/merchant-mcp.test.ts"],
    reach: {
      mcpTools: ["kiwi_merchant_get_inventory", "kiwi_merchant_prepare_inventory_update"],
    },
  },
  {
    id: "F08",
    title: "上下架（销售状态变更）",
    category: "B",
    capability: "partial",
    buddy: "wired",
    v2Scope: "committed",
    evidence: ["tests/merchant-capability-probe.test.ts", "tests/merchant-commands.test.ts"],
    reach: { mcpTools: ["kiwi_merchant_prepare_listing_change"] },
    note: "受限交付：「销售状态」语义已接入写闭环；上游 shopping-cli 2.x 无端点 → 能力缺失时 fail-closed「不可得」（P0-3）",
  },
  {
    id: "F09",
    title: "A2A 自动接待（RFQ/offer/counter/conditional）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: [
      "tests/merchant-handler-accept-validation.test.ts",
      "tests/merchant-delivery-terms.test.ts",
    ],
    note: "A2A 接待本身已运行（V1 交付）；Buddy 侧接待过程工作台展示延后，不宣称交付",
  },
  {
    id: "F10",
    title: "澄清/终止（clarification/withdraw/decline/cancel）",
    category: "A",
    capability: "partial",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/merchant-handler-accept-validation.test.ts"],
    note: "商家主动干预命令未实现（不假称已有）；延后",
  },
  {
    id: "F11",
    title: "非绑定协议查看（agreement artifact）",
    category: "A",
    capability: "covered",
    buddy: "partial",
    v2Scope: "committed",
    evidence: ["tests/merchant-handler-accept-validation.test.ts", "tests/merchant-mcp.test.ts"],
    reach: { mcpTools: ["kiwi_merchant_list_a2a_negotiations"] },
    note: "受限交付：MCP 经 list_a2a_negotiations 可见 agreement 标记；详情视图延后",
  },
  {
    id: "F12",
    title: "磋商列表与状态追溯",
    category: "A",
    capability: "covered",
    buddy: "wired",
    v2Scope: "committed",
    evidence: ["tests/merchant-workbench-service.test.ts", "tests/merchant-mcp.test.ts"],
    reach: { mcpTools: ["kiwi_merchant_list_a2a_negotiations"] },
  },
  {
    id: "F13",
    title: "shopping-cli 会话轨（snapshot/claim/decision）",
    category: "A",
    capability: "partial",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/agent-consultation.test.ts"],
    note: "两轨统一列表（source_protocol）延后；不宣称交付",
  },
  {
    id: "F14",
    title: "人工审核队列与处理",
    category: "B",
    capability: "partial",
    buddy: "partial",
    v2Scope: "committed",
    evidence: ["tests/merchant-commands.test.ts", "tests/merchant-core.test.ts"],
    reach: {
      mcpTools: ["kiwi_merchant_list_human_reviews", "kiwi_merchant_prepare_review_resolve"],
    },
    note: "受限交付：两轨路由守卫已落地（shopping 轨经 prepare_review_resolve 走写闭环；A2A 轨 fail-closed「不可得」绝不跨轨）",
  },
  {
    id: "F15",
    title: "审批候选（pending/approve/reject/过期）",
    category: "A",
    capability: "covered",
    buddy: "wired",
    v2Scope: "committed",
    evidence: ["tests/merchant-workbench-service.test.ts", "tests/merchant-admin-security.test.ts"],
    reach: { adminPage: true },
    note: "批准/拒绝唯一通道 = 管理确认页（登录会话 + 一次性确认凭证绑定候选摘要/主体/动作，单次用途；BUG-01/02/03 修复后有专项测试）",
  },
  {
    id: "F16",
    title: "操作授权模式（manual/supervised/autopilot）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/merchant-pack.test.ts"],
    note: "MCP 写工具固定 supervised（安全口径）；模式切换的 Buddy 接线延后",
  },
  {
    id: "F17",
    title: "策略配置查看与变更（MerchantPolicy）",
    category: "A",
    capability: "partial",
    buddy: "wired",
    v2Scope: "committed",
    evidence: [
      "tests/profile.test.ts",
      "tests/merchant-commands.test.ts",
      "tests/merchant-policy-runtime.test.ts",
    ],
    reach: { mcpTools: ["kiwi_merchant_prepare_policy_change"] },
    note: "受限交付：变更走写闭环；BUG-07 修复后经 MerchantPolicyRuntime 校验+原子写完整生效策略，A2A/执行器按运行中策略即时生效（跨进程）；策略查看面仍以 profile 为准",
  },
  {
    id: "F18",
    title: "运营统计（merchant stats，UTC 口径）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/merchant-stats.test.ts"],
    note: "能力已在 CLI（merchant stats）覆盖；Buddy 接线延后",
  },
  {
    id: "F19",
    title: "经营分析（intelligence 摘要/指标/健康/摘要/待审批）",
    category: "A",
    capability: "covered",
    buddy: "wired",
    v2Scope: "committed",
    evidence: ["tests/merchant-intelligence.test.ts", "tests/merchant-digest-terms.test.ts"],
    reach: { mcpTools: ["kiwi_merchant_get_analytics"] },
  },
  {
    id: "F20",
    title: "七类展示组件",
    category: "A",
    capability: "covered",
    buddy: "wired",
    v2Scope: "committed",
    evidence: ["tests/merchant-presentation.test.ts", "tests/merchant-resources.test.ts"],
    reach: { mcpResources: true },
    note: "受限交付：已映射 MCP 资源（JSON + 文本降级双 content）；MCP Apps 嵌入形态待平台预览验证（PLATFORM_MANUAL）",
  },
  {
    id: "F21",
    title: "六个商家 Skill",
    category: "A",
    capability: "covered",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/merchant-skills.test.ts"],
    note: "Buddy 适配新工具名延后；不宣称交付",
  },
  {
    id: "F22",
    title: "记忆治理（remember/forget/correct/confirm）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/agent-memory.test.ts", "tests/merchant-buddy/stage2-acceptance.test.ts"],
    note: "远程场景不挂记忆 MCP 工具（人员授权边界，已测）；Buddy 接线延后",
  },
  {
    id: "F23",
    title: "私密阈值面板（PrivateVault）",
    category: "A",
    capability: "partial",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: [
      "tests/agent-memory.test.ts",
      "tests/merchant-core.test.ts",
      "tests/merchant-buddy/stage2-acceptance.test.ts",
    ],
    note: "私密数值不进任何工具结果与资源（已测）；管理面接缝带读取审计；面板 UI 延后",
  },
  {
    id: "F24",
    title: "profile/模型配置与会话恢复",
    category: "A",
    capability: "partial",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/profile.test.ts"],
    note: "Buddy 侧仅商家 profile；禁止切 buyer（阶段二验收）；完整配置面延后",
  },
  {
    id: "F25",
    title: "网络身份/注册/发现检查",
    category: "A",
    capability: "covered",
    buddy: "partial",
    v2Scope: "committed",
    evidence: ["tests/catalog-register.test.ts", "tests/merchant-buddy/stage4-acceptance.test.ts"],
    note: "受限交付：checkNetworkRegistration 结构化注册检查（失效可检测）；Buddy 入口展示延后",
  },
  {
    id: "F26",
    title: "Ledger/幂等/相位恢复",
    category: "A",
    capability: "covered",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/ledger.test.ts", "tests/idempotency.test.ts"],
    note: "底层能力已覆盖；Buddy 侧视图延后",
  },
  {
    id: "F27",
    title: "实例启停/日志/健康（runtime 管理）",
    category: "A",
    capability: "covered",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/merchant-runtime.test.ts", "tests/supervisor.test.ts"],
    note: "能力已在 CLI（merchant runtime start|stop|status|health）覆盖；Buddy 接线延后",
  },
  {
    id: "F28",
    title: "listings/status/doctor 结构化服务",
    category: "C",
    capability: "partial",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/merchant-runtime.test.ts"],
    note: "实例 status/health 已由 merchant runtime 落地；listings 与 merchant doctor 结构化服务仍缺（不假称已有）",
  },
  {
    id: "F29",
    title: "微信通道与旧入口兼容",
    category: "A",
    capability: "partial",
    buddy: "partial",
    v2Scope: "committed",
    evidence: ["tests/weixin-cli.test.ts", "tests/merchant-buddy/stage4-acceptance.test.ts"],
    note: "受限交付：getWeixinStatus 只读接缝（脱敏；无事件存储明确「不可得」）；绑定/撤销操作延后",
  },
  {
    id: "F30",
    title: "受限 decision backend（不作为生产定价权威）",
    category: "A",
    capability: "partial",
    buddy: "pending",
    v2Scope: "deferred",
    evidence: ["tests/merchant-decision-backend.test.ts"],
    note: "decision backend 组件已测；Buddy/生产定价权威接线延后（merchant 定价是确定性策略，不依赖 LLM）",
  },
];
