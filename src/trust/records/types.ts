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
 * trust/records — WP1 CounterpartyTrustRecord 领域类型（基线 §27 / §28）。
 *
 * 三维信任（Identity / Protocol / Commercial Reputation，§27）不得合并成单一
 * “可信度”。本模块只持久化对端的事实记录：观察（facts）与评估（conclusions）
 * 分离 —— observe 只改事实；trust_level / rejected 只能由评估器推导，observe
 * 无法直接写入（TrustObservation 没有 level 字段）。
 *
 * Reputation（§27 Commercial Reputation）：没有 reputation 就是显式 unknown，
 * 绝不自动当成 neutral 0.5。ReputationSignal 把这一点做成类型契约。
 */

import type { TrustLevel } from "../identity/trust-policy.js";
import { contentDigest } from "../../negotiation/jcs.js";

/** 记录 schema 版本（迁移用）。 */
export const TRUST_RECORD_SCHEMA_VERSION = 1 as const;

/**
 * §27 Dispute 三级分类：本地单方标记（local_asserted）不得伪装成全球事实
 * （mutually_acknowledged / third_party_adjudicated 需要对端或第三方证据）。
 */
export type DisputeClassification =
  "local_asserted" | "mutually_acknowledged" | "third_party_adjudicated";

export const DISPUTE_CLASSIFICATIONS: readonly DisputeClassification[] = [
  "local_asserted",
  "mutually_acknowledged",
  "third_party_adjudicated",
];

export interface DisputeRecord {
  /** 稳定去重 id（调用方提供，或按内容哈希生成）。 */
  dispute_id: string;
  /** §27 三级分类。 */
  classification: DisputeClassification;
  reason?: string;
  occurred_at: string;
  /** 争议是否已解决。只影响互认/本地争议的等级封顶；已裁决争议始终拒绝。 */
  resolved?: boolean;
}

/**
 * 可观察的事实（§27 Protocol Trust 观察项 + 成功交换 + dispute）。
 * 通道/服务器交互把这里的事件 append 进 record；评估器据此推导结论。
 */
export type ObservationKind =
  | "exchange_success"
  | "schema_invalid"
  | "timeout"
  | "replay_detected"
  | "signature_failure"
  | "dispute";

/** 一条事实观察。只含事实；不含任何 trust level 结论。 */
export interface TrustObservation {
  /** 对端身份（协议幂等键 counterparty 侧；来自 Agent Card provider/name）。 */
  counterparty_identity: string;
  kind: ObservationKind;
  /** 观察时间（RFC 3339）；缺省用 store 时钟。 */
  observed_at?: string;
  /** 通道/服务器上下文（diagnostic）。 */
  context?: string;
  /** 对端域名（首次观察时建立）。 */
  domain?: string;
  /** provider（解析来源：`domain:<host>` 或 `card:<url>`，首次观察时建立）。 */
  provider?: string;
  /**
   * Agent Card 指纹（exchange_success 时携带）。与已存指纹不同 → 告警信号
   * （ObserveResult.fingerprintChanged）而非静默接受。
   */
  agent_card_fingerprint?: string;
  /** 本次观察到的 capability 版本（exchange_success 时合并）。 */
  capability_versions?: Record<string, string>;
  /** dispute 观察附加信息。 */
  dispute?: {
    dispute_id?: string;
    classification?: DisputeClassification;
    reason?: string;
    resolved?: boolean;
  };
}

/**
 * CounterpartyTrustRecord 的事实面（观察聚合）。结论（trust_level / rejected /
 * evaluated_at）不在此面，由评估器从这些事实推导。
 */
export interface TrustRecordFacts {
  counterparty_identity: string;
  /** 成功交换累计数（schema 有效 + 签名有效 + 正常完成）。 */
  successful_exchanges: number;
  /**
   * 当前连续成功验签交换数。signature_failure / replay / Agent Card 指纹变更时
   * 清零 —— 连续性是事实聚合，不是结论。
   */
  consecutive_verified_exchanges: number;
  invalid_schema_count: number;
  timeout_count: number;
  replay_detected_count: number;
  signature_failure_count: number;
  /** §27 三级分类争议记录（reputation 维度；评估器只做保守封顶/拒绝，不合并进协议 level）。 */
  local_asserted_disputes: DisputeRecord[];
  /** 检测到的 Agent Card 指纹变更次数（identity 锚变更；告警信号持久化，崩溃后仍可发现）。 */
  fingerprint_changes: number;
}

/** 一条对端信任记录：事实面 + 元数据 + 结论（结论只由评估器写入）。 */
export interface CounterpartyTrustRecord extends TrustRecordFacts {
  /** 对端域名（经 domain 发现时）。 */
  domain?: string;
  /** 当前 Agent Card 指纹（identity 锚；变更时先记入 fingerprint_changes 再更新）。 */
  agent_card_fingerprint?: string;
  /** provider（解析来源：`domain:<host>` / `card:<url>`）。 */
  provider?: string;
  /** 观察到的 capability 版本（capability id → 最近一次观测版本）。 */
  capability_versions: Record<string, string>;
  first_seen: string;
  last_seen: string;
  last_fingerprint_change_at?: string;
  schema_version: typeof TRUST_RECORD_SCHEMA_VERSION;
  // -- 结论（评估器推导，评估得出而非自填） --
  /** 评估推导的 trust level（T0-T3，§28）。 */
  trust_level: TrustLevel;
  evaluated_at: string;
  /** 评估器建议拒绝（超硬阈值 / 已裁决争议）：调用方应拒绝自动化交互。 */
  rejected: boolean;
  rejection_reason?: string;
}

/**
 * §27 Commercial Reputation 信号：没有数据必须是显式 `{ status: "unknown" }`，
 * 绝不自动当 0.5。Ranker 侧直接消费该信号。
 */
export type ReputationSignal = { status: "unknown" } | { status: "known"; score: number };

/** Reputation 来源接缝。缺省 NO_REPUTATION（恒 unknown）。 */
export interface ReputationSource {
  score(identity: string): ReputationSignal;
}

/**
 * 参与 Agent Card 指纹的 identity 承载字段（结构性输入，与 discovery 解耦）。
 * 指纹覆盖 name / provider / version / url / supportedInterfaces；不含 capabilities
 * —— 能力变化是合法演进，由 capability_versions 单独跟踪。
 */
export interface AgentCardIdentityMaterial {
  name: string;
  provider?: { organization?: string; url?: string };
  version?: string;
  url?: string;
  supportedInterfaces?: Array<{
    url: string;
    protocolBinding?: string;
    protocolVersion?: string;
  }>;
}

/**
 * Agent Card 指纹：对 identity 承载字段做 JCS canonicalize + SHA-256（sha256:<hex>）。
 * supportedInterfaces 先按 url 排序，避免接口声明顺序变化触发假告警。
 */
export function computeAgentCardFingerprint(card: AgentCardIdentityMaterial): string {
  const normalized: AgentCardIdentityMaterial = {
    name: card.name,
    provider: card.provider,
    version: card.version,
    url: card.url,
    supportedInterfaces:
      card.supportedInterfaces === undefined
        ? undefined
        : [...card.supportedInterfaces].sort((a, b) =>
            a.url < b.url ? -1 : a.url > b.url ? 1 : 0,
          ),
  };
  return contentDigest(normalized);
}
