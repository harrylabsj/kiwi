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
 * 商品经营计划（v0.2 §5.1 / FR01–FR04）。
 *
 * 计划只引用外部商品身份与事实，不复制库存/价格主数据。conditions 与
 * actions 是商家经营条件的版本化 JSON（M0 冻结字段前只做结构边界校验，
 * 不提前发明最终枚举）；生效区间、暂停/恢复、版本切换是强约束。
 */

export type OperatingPlanStatus = "ACTIVE" | "PAUSED";

export type OperatingPlanErrorCode =
  | "validation"
  | "not_found"
  | "version_conflict"
  | "interval_overlap"
  | "invalid_interval"
  | "plan_paused"
  | "plan_expired"
  | "authorization_revoked"
  | "idempotency_conflict"
  | "corrupt_plan_intervals";

export class OperatingPlanError extends Error {
  readonly code: OperatingPlanErrorCode;
  constructor(code: OperatingPlanErrorCode, message: string) {
    super(message);
    this.name = "OperatingPlanError";
    this.code = code;
  }
}

export interface OperatingPlanAuthorization {
  /** 计划负责人（商家主体账号）。 */
  owner: string;
  /** 授权范围（例如 publish_quote / follow_up / approve_exception）。 */
  scopes: string[];
  /** 授权到期时间；缺省表示随计划区间。 */
  expires_at?: string;
  /** 显式撤销时间；撤销后不得恢复为新动作的执行依据。 */
  revoked_at?: string;
}

export interface OperatingPlanInput {
  merchant_id: string;
  /** 商品源命名空间（例如 shopping-cli）。 */
  source: string;
  /** 来源账户；外部连接器/凭据确定，不接受请求正文自报。 */
  source_account_id: string;
  sku: string;
  /** 计费商品引用（可选；D02 签认前不启用计费）。 */
  billing_ref?: string;
  template_id?: string;
  template_revision?: number;
  /** 生效区间，UTC，半开 [effective_from, effective_to)。 */
  effective_from: string;
  effective_to?: string;
  /** 适用需求/规格/地区/交付条件；字段枚举由 M0 冻结。 */
  conditions: Record<string, unknown>;
  /** 允许动作：促销、阶梯、替代、交付方式、人工例外入口。 */
  actions: Record<string, unknown>;
  authorization: OperatingPlanAuthorization;
  /** 私有成本/底价规则引用；只存引用，不存成本本身。 */
  private_rules_ref?: string;
}

export interface OperatingPlan extends OperatingPlanInput {
  plan_id: string;
  status: OperatingPlanStatus;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface UpdateOperatingPlanInput {
  merchant_id: string;
  plan_id: string;
  expected_revision: number;
  /** 只允许修改未开始生效的计划；已生效计划用 switchVersion。 */
  patch: Partial<Omit<OperatingPlanInput, "merchant_id" | "source" | "source_account_id" | "sku">>;
}

export interface SwitchPlanVersionInput {
  merchant_id: string;
  plan_id: string;
  expected_revision: number;
  /** 新版本生效时间；必须晚于当前版本生效时间且落在当前区间内。 */
  effective_from: string;
  /** 新版本覆盖项；未提供的字段沿用旧版本。 */
  patch: Partial<Omit<OperatingPlanInput, "merchant_id" | "source" | "source_account_id" | "sku">>;
}

export interface PlanReadinessInput {
  /** 当前时间（RFC 3339）。 */
  at: string;
  /** 成本快照是否完整；缺省未知。 */
  cost_complete?: boolean;
  /** 是否启用最低贡献硬门。 */
  contribution_gate_enabled?: boolean;
  /** 外部订单源是否已接通且可用。 */
  order_source_ready?: boolean;
}

export interface ReadinessCheck {
  ok: boolean;
  blockers: string[];
}

export interface OperatingPlanReadiness {
  can_receive_demand: ReadinessCheck;
  can_publish_quote: ReadinessCheck;
  can_verify_orders: ReadinessCheck;
}
