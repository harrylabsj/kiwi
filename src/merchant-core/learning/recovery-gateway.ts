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
 * 评测派发终态网关适配（交接报告恢复顺序第 1 步）。
 *
 * 网关必须能按 `dispatch_id` 回答整次评测关联请求的终态，并明确：
 * - completed：返回该次尝试的结果；
 * - not_executed：必须带 `future_execution_blocked=true` 与终态原因，证明
 *   该 dispatch 今后不可能执行；仅 404/超时/查无记录都不算；
 * - unknown：其余情况保持阻塞。
 *
 * 响应必须回传 binding_digest；与本地 binding 不一致时按 unknown 处理。
 * 本模块不记录密钥或原始回执，只在内存中校验。
 */

import { contentDigest } from "../../negotiation/jcs.js";
import type {
  EvaluationRecoveryBinding,
  EvaluationRecoveryVerification,
} from "./service.js";
import type { EvaluationAttemptOutcome } from "./evaluation.js";

export interface RecoveryGatewayOptions {
  readonly base_url: string;
  /** 网关鉴权头；由调用方从安全配置读取，不落日志。 */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly timeout_ms?: number;
}

interface GatewayResponse {
  dispatch_id?: unknown;
  binding_digest?: unknown;
  status?: unknown;
  future_execution_blocked?: unknown;
  terminal_reason?: unknown;
  outcome?: unknown;
  evidence_id?: unknown;
}

function validOutcome(value: unknown): EvaluationAttemptOutcome | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.passed !== "boolean") return undefined;
  if (!Number.isSafeInteger(record.hard_gate_failures) || (record.hard_gate_failures as number) < 0) {
    return undefined;
  }
  if (
    record.improvement_delta !== undefined &&
    (typeof record.improvement_delta !== "number" || !Number.isFinite(record.improvement_delta))
  ) {
    return undefined;
  }
  return {
    passed: record.passed,
    hard_gate_failures: record.hard_gate_failures as number,
    ...(typeof record.improvement_delta === "number"
      ? { improvement_delta: record.improvement_delta }
      : {}),
  };
}

/** 构造 `recoveryVerifier`；任何网络/契约/摘要异常都返回 unknown（fail-closed）。 */
export function createRecoveryGatewayVerifier(
  options: RecoveryGatewayOptions,
): (binding: EvaluationRecoveryBinding, evidenceRef: string) => Promise<EvaluationRecoveryVerification> {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (binding, _evidenceRef) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout_ms ?? 15_000);
    try {
      const url = new URL(
        `evaluations/dispatches/${encodeURIComponent(binding.dispatch_id)}`,
        options.base_url.endsWith("/") ? options.base_url : `${options.base_url}/`,
      );
      url.searchParams.set("binding_digest", contentDigest(binding));
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", ...options.headers },
        signal: controller.signal,
      });
      if (response.status !== 200) return { status: "unknown" };
      const body = (await response.json()) as GatewayResponse;
      if (body.dispatch_id !== binding.dispatch_id) return { status: "unknown" };
      if (body.binding_digest !== contentDigest(binding)) return { status: "unknown" };
      if (body.status === "not_executed") {
        if (body.future_execution_blocked !== true) return { status: "unknown" };
        if (typeof body.terminal_reason !== "string" || body.terminal_reason.trim() === "") {
          return { status: "unknown" };
        }
        return { status: "not_executed", binding };
      }
      if (body.status === "completed") {
        const outcome = validOutcome(body.outcome);
        if (outcome === undefined) return { status: "unknown" };
        return { status: "completed", binding, outcome };
      }
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    } finally {
      clearTimeout(timer);
    }
  };
}


/** 从环境变量构造；未配置 URL 时返回 undefined（保持原阻塞行为）。 */
export function createRecoveryGatewayVerifierFromEnv(
  env: Record<string, string | undefined> = process.env,
): ((binding: EvaluationRecoveryBinding, evidenceRef: string) => Promise<EvaluationRecoveryVerification>) | undefined {
  const baseUrl = String(env.KIWI_EVAL_RECOVERY_GATEWAY_URL ?? "").trim();
  if (baseUrl === "") return undefined;
  const token = String(env.KIWI_EVAL_RECOVERY_GATEWAY_TOKEN ?? "").trim();
  return createRecoveryGatewayVerifier({
    base_url: baseUrl,
    ...(token !== "" ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}
