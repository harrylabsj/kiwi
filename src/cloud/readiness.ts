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
 * 云端就绪检查（设计 v0.1.2 §8.2 GET /readyz）。
 *
 * 语义边界：
 *   - readyz 只表达"组件就绪"（身份 / 权威存储 / 商品源 / 策略），**不替代**
 *     真实 A2A 测试，也不承载业务数据；
 *   - 输出只有布尔与稳定 reason code，绝不回显 merchant_id、商品数量、密钥
 *     指纹等敏感内容（M0 事实：公网可直接访问，探针即信息面）；
 *   - 每个检查有超时上限：探针不得挂起，也不得消耗无界资源（设计 §15.3）。
 */

export interface ReadinessCheckResult {
  ok: boolean;
  /** 稳定原因码（失败时给出；不含敏感值）。 */
  code?: string;
}

export interface ReadinessInputs {
  /** 身份：签名私钥/商家绑定可加载且未损坏。 */
  identity: () => Promise<ReadinessCheckResult> | ReadinessCheckResult;
  /** 权威存储：可写且可读回（CAS/幂等语义的最小验证由 M2 承接）。 */
  storage: () => Promise<ReadinessCheckResult> | ReadinessCheckResult;
  /** 商品源：存在可用且在有效期内的真实商品（测试商品须显式标记）。 */
  products: () => Promise<ReadinessCheckResult> | ReadinessCheckResult;
  /** 策略：运行中生效策略已装载且版本可读。 */
  policy: () => Promise<ReadinessCheckResult> | ReadinessCheckResult;
  timeoutMs?: number;
  now?: () => Date;
}

export interface ReadinessReport {
  ready: boolean;
  checked_at: string;
  checks: Record<string, ReadinessCheckResult>;
}

const DEFAULT_TIMEOUT_MS = 2000;

async function withTimeout(
  name: string,
  fn: () => Promise<ReadinessCheckResult> | ReadinessCheckResult,
  timeoutMs: number,
): Promise<ReadinessCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn),
      new Promise<ReadinessCheckResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, code: `${name.toUpperCase()}_TIMEOUT` }), timeoutMs);
        // 探针超时不应阻止进程退出。
        timer.unref?.();
      }),
    ]);
    return result;
  } catch (err) {
    // 异常消息可能含内部细节：只回稳定码，细节留在调用方日志。
    void err;
    return { ok: false, code: `${name.toUpperCase()}_ERROR` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 逐项执行就绪检查；任一项失败即 not ready（不短路，便于一次看清全部缺口）。 */
export async function runReadiness(inputs: ReadinessInputs): Promise<ReadinessReport> {
  const timeoutMs = inputs.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = inputs.now ?? (() => new Date());
  const [identity, storage, products, policy] = await Promise.all([
    withTimeout("identity", inputs.identity, timeoutMs),
    withTimeout("storage", inputs.storage, timeoutMs),
    withTimeout("products", inputs.products, timeoutMs),
    withTimeout("policy", inputs.policy, timeoutMs),
  ]);
  const checks = { identity, storage, products, policy };
  const ready = Object.values(checks).every((c) => c.ok);
  return { ready, checked_at: now().toISOString(), checks };
}
