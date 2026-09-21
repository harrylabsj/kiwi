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
 * 本地兜底状态（设计 §5.4「验证本地兜底两种状态：首次未发布与已营业故障；
 * 允许暂停/撤回等安全动作」；T012）。
 *
 * 控制面不可达或组件故障时，**前端/本地视图只能如实描述现状**：
 *
 *   - 没有活动发布 → `FIRST_TIME_UNPUBLISHED`：**不接待新询价**，也绝不显示成
 *     "已开通/营业中"。首次开通失败不允许"先挂出去再说"。
 *   - 有活动发布但组件或上游故障 → `OPERATING_DEGRADED`：**停止受影响的新询价**，
 *     运行状态如实更新；**暂停/撤回等安全动作仍然可用**（安全动作不能因为故障被锁死）。
 *
 * 三条纪律：
 *   1. **本地视图不是权威状态**：是否可对外营业以发布记录/控制面为准；
 *   2. 兜底页**绝不宣布"已恢复"**——恢复要么由权威证据推动，要么由商家显式动作；
 *   3. 安全动作（暂停/撤回）在**任何**状态下可用（除了已经撤回/已暂停）。
 */

import type { ReadinessReport } from "../readiness.js";
import type { PlatformAdapterFailure, PlatformEvidenceResult } from "./types.js";

/** 本地可见的发布治理状态（与 Catalog 侧 ACTIVE/PAUSED/WITHDRAWN 同词汇）。 */
export type LocalPublicationState = "NONE" | "ACTIVE" | "PAUSED" | "WITHDRAWN";

/** 安全动作：任何状态下都要能按到（除了已经处于该状态）。 */
export const SAFE_ACTIONS = ["pause", "withdraw", "resume", "republish"] as const;
export type SafeAction = (typeof SAFE_ACTIONS)[number];

export type LocalFallbackState =
  /** 首次未发布：从没成功发布过，也没有活动版本。 */
  | "FIRST_TIME_UNPUBLISHED"
  /** 已营业但故障：有活动版本，但组件/上游不就绪。 */
  | "OPERATING_DEGRADED"
  /** 已暂停（商家动作或治理）。 */
  | "PAUSED_BY_MERCHANT"
  /** 已撤回。 */
  | "WITHDRAWN"
  /** 正常营业。 */
  | "OPERATING";

export interface LocalFallbackInput {
  /** 本地已知的发布治理状态（来自服务端记录；NONE = 从未发布）。 */
  publicationState: LocalPublicationState;
  /** 就绪报告（组件维度）；控制面不可达时也可本地取得。 */
  readiness: Pick<ReadinessReport, "ready" | "checks">;
  /** 到控制面（Catalog）的连通性：未知/不可达时不得推断为"正常"。 */
  controlPlaneReachable: boolean;
}

export interface LocalFallbackView {
  state: LocalFallbackState;
  /** 是否接待新询价（安全闸门；由状态推导，不由 UI 决定）。 */
  acceptsNewInquiries: boolean;
  /** 当前可用的安全动作。 */
  safeActions: SafeAction[];
  /** 面向商家的如实描述（中文；不含敏感值）。 */
  summary: string;
  /** 是否需要与控制面对账后才能确认状态（不可达时恒为 true）。 */
  requiresControlPlaneReconciliation: boolean;
  /**
   * 权威边界声明：**本地视图不是权威状态**。调用方必须原样展示，不得省略。
   */
  authorityNote: string;
}

/**
 * 平台失败响应是否要求启用本地实现。这个字段只能触发“明确拒绝并保持安全态”，
 * 绝不能被当作继续开通、发布或恢复营业的许可。
 */
export function requestsDisabledLocalImplementation(
  result: PlatformEvidenceResult,
): result is PlatformAdapterFailure & { useLocalImplementation: true } {
  return result?.kind === "platform_failure" && result.useLocalImplementation === true;
}

const AUTHORITY_NOTE =
  "本地视图不是权威状态：是否可对外营业以发布记录与控制面为准；本地不会自行宣布“已恢复”。";

export function deriveLocalFallback(input: LocalFallbackInput): LocalFallbackView {
  const failedChecks = Object.entries(input.readiness.checks ?? {})
    .filter(([, result]) => !result.ok)
    .map(([name]) => name);
  const componentsOk = input.readiness.ready && failedChecks.length === 0;

  const base = {
    requiresControlPlaneReconciliation: !input.controlPlaneReachable,
    authorityNote: AUTHORITY_NOTE,
  };

  switch (input.publicationState) {
    case "NONE":
      // 首次未发布：没有活动版本 → 不接待。绝不因为"组件就绪"就当成可营业。
      return {
        ...base,
        state: "FIRST_TIME_UNPUBLISHED",
        acceptsNewInquiries: false,
        safeActions: ["republish"],
        summary:
          "尚未发布：没有已生效的名片与绑定，当前不接待新询价。完成开通后才会对外可见。",
      };
    case "PAUSED":
      return {
        ...base,
        state: "PAUSED_BY_MERCHANT",
        acceptsNewInquiries: false,
        safeActions: ["resume", "withdraw"],
        summary: "已暂停：公开信息仍可查，但不接待新询价。可以恢复或撤回。",
      };
    case "WITHDRAWN":
      return {
        ...base,
        state: "WITHDRAWN",
        acceptsNewInquiries: false,
        safeActions: ["republish"],
        summary: "已撤回：名片读地址返回 410，不接待新询价。重新发布需新建版本。",
      };
    case "ACTIVE":
      if (!componentsOk) {
        // 已营业故障：有活动版本但组件不就绪 → 停止受影响的新询价；安全动作仍可用。
        return {
          ...base,
          state: "OPERATING_DEGRADED",
          acceptsNewInquiries: false,
          safeActions: ["pause", "withdraw"],
          summary: `营业异常：名片仍然公开，但组件未就绪（${failedChecks.join(", ") || "readiness"}），已停止接待新询价。可暂停或撤回。`,
        };
      }
      return {
        ...base,
        state: "OPERATING",
        acceptsNewInquiries: true,
        safeActions: ["pause", "withdraw"],
        summary: "营业中：名片与绑定有效，组件就绪，正常接待询价。",
      };
    default: {
      const exhaustive: never = input.publicationState;
      throw new Error(`unhandled publication state: ${String(exhaustive)}`);
    }
  }
}

/**
 * 控制面不可达时的**额外**约束：即使本地一切正常，也不得据此宣布"恢复"。
 *
 * 返回需要商家显式确认的动作清单（如故障期间新到的询价恢复后如何处置）。
 */
export function degradedRecoveryAsk(input: LocalFallbackInput): string[] {
  if (input.controlPlaneReachable) return [];
  return [
    "控制面暂不可达：先在控制面核对发布记录与绑定状态，再继续接待",
    "故障期间的询价不会自动补发或自动成交，恢复后由商家决定如何处置",
  ];
}
