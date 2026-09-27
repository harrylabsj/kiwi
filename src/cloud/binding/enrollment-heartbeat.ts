/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** 已发布接入的签名心跳：从持久状态续办，不保留/使用 owner token 或短期 grant。 */
import { createPublicKey, randomBytes } from "node:crypto";
import { isRedirectResponse, readJsonBody } from "../../net/safe-http.js";
import { publicKeyThumbprint } from "../../trust/binding/thumbprint.js";
import { signCompactJws, type JwsSigningIdentity } from "../../trust/identity/jws.js";
import { readEnrollmentStore } from "./enrollment-challenge.js";

export interface EnrollmentHeartbeatOptions {
  dataDir: string;
  signingIdentity: JwsSigningIdentity;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (error: Error) => void;
  isReady?: () => boolean | Promise<boolean>;
}

export interface EnrollmentHeartbeat {
  tick: () => Promise<void>;
  stop: () => void;
}

/** 无接入记录时不发请求；每次重新读取，因此 CLI 完成发布后无需重启服务。 */
export function startEnrollmentHeartbeat(options: EnrollmentHeartbeatOptions): EnrollmentHeartbeat {
  const intervalMs = options.intervalMs ?? 300_000;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new Error("心跳间隔必须是正数");
  const fetchImpl = options.fetchImpl ?? fetch;
  const thumbprint = publicKeyThumbprint(createPublicKey(options.signingIdentity.privateKey));
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;

  async function perform(): Promise<void> {
    if (options.isReady !== undefined && !(await options.isReady())) return;
    let state: ReturnType<typeof readEnrollmentStore>;
    try {
      state = readEnrollmentStore(options.dataDir);
    } catch {
      throw new Error("无法读取接入状态；已停止本轮心跳，请检查 Runtime 状态存储");
    }
    // 地址迁移/密钥恢复中的新授权优先于旧发布态：用户同意并完成新绑定前
    // 不替旧origin/key续freshness，避免将待迁移实例继续显示为可询价。
    const pendingSessions = state.sessions.filter((session) => ["preparing", "authorized", "bound"].includes(session.status));
    const pendingAgentIds = new Set(pendingSessions
      .map((session) => {
        const item = session as unknown as Record<string, unknown>;
        return item["expected_catalog_agent_id"] ?? item["catalog_agent_id"];
      })
      .filter((agentId): agentId is string => typeof agentId === "string" && agentId !== ""));
    if (pendingSessions.some((session) => session.key_thumbprint === thumbprint)) return;
    const seen = new Set<string>();
    for (const session of state.sessions) {
      if (stopped) return;
      if (session.status !== "published" || session.key_thumbprint !== thumbprint) continue;
      const item = session as unknown as Record<string, unknown>;
      const catalogOrigin = item["catalog_origin"];
      const agentId = item["catalog_agent_id"];
      const bindingId = item["binding_id"];
      if (
        typeof catalogOrigin !== "string" ||
        typeof agentId !== "string" ||
        typeof bindingId !== "string" ||
        !agentId ||
        !bindingId
      ) {
        throw new Error("已发布接入缺少 Catalog/绑定信息，无法发送心跳");
      }
      if (pendingAgentIds.has(agentId)) continue;
      const target = new URL(catalogOrigin);
      if (target.protocol !== "https:" || target.origin !== catalogOrigin) {
        throw new Error("接入状态中的 Catalog 必须是完整 HTTPS origin");
      }
      const key = `${catalogOrigin}:${agentId}:${bindingId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const signature = signCompactJws(
        {
          agent_id: agentId,
          binding_id: bindingId,
          issued_at: new Date().toISOString(),
          nonce: randomBytes(24).toString("base64url"),
        },
        options.signingIdentity,
        { extraHeader: { typ: "kiwi-runtime-request" } },
      );
      const abort = new AbortController();
      controller = abort;
      const timeout = setTimeout(() => abort.abort(), 10_000);
      timeout.unref();
      try {
        const response = await fetchImpl(
          `${catalogOrigin}/v1/agent-catalog/agents/${encodeURIComponent(agentId)}/heartbeat`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-kiwi-binding-jws": signature },
            body: "{}",
            redirect: "manual",
            signal: abort.signal,
          },
        );
        if (isRedirectResponse(response) || !response.ok) {
          await response.body?.cancel();
          throw new Error(`Catalog 心跳被拒绝（HTTP ${response.status}）`);
        }
        const body = await readJsonBody(response, { maxBytes: 64 * 1024, signal: abort.signal });
        if (
          body === null ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          (body as Record<string, unknown>)["ok"] !== true ||
          (body as Record<string, unknown>)["catalog_agent_id"] !== agentId
        ) {
          throw new Error("Catalog 心跳回执与当前接入不一致");
        }
      } finally {
        clearTimeout(timeout);
        controller = undefined;
      }
    }
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight !== undefined) return inFlight;
    inFlight = perform().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }
  function schedule(): void {
    void tick().catch(() => {
      if (stopped) return;
      const error = new Error("Catalog 签名心跳失败；目录可能将服务标记为不新鲜，将在下一轮重试");
      if (options.onError !== undefined) options.onError(error);
      else process.stderr.write(`[kiwi] ${error.message}\n`);
    });
  }
  const timer = setInterval(schedule, intervalMs);
  timer.unref();
  schedule();
  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
    },
  };
}
