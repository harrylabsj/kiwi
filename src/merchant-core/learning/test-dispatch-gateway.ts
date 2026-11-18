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
 * 评测终态测试网关（本地验收用，不连接供应商）。
 *
 * 提供 `GET /evaluations/dispatches/:id` 的严格契约，以及写入/执行端点：
 * - `POST /dispatch/:id/not-executed` 标记终态并证明今后不可执行；
 * - `POST /dispatch/:id/complete` 写入结果；
 * - `POST /dispatch/:id/execute` 在终态后返回 409，证明不会再次执行。
 *
 * 该网关只证明“本网关控制的请求”不再执行，不代表模型供应商的官方保证。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

type TerminalStatus = "completed" | "not_executed" | "unknown";

interface GatewayRecord {
  dispatch_id: string;
  binding_digest: string;
  status: TerminalStatus;
  future_execution_blocked: boolean;
  terminal_reason?: string;
  outcome?: Record<string, unknown>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 64 * 1024) reject(new Error("body_too_large"));
    });
    req.on("end", () => {
      try {
        const parsed = raw === "" ? {} : JSON.parse(raw);
        resolve(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {});
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

export interface TestDispatchGateway {
  server: Server;
  records: Map<string, GatewayRecord>;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createTestDispatchGateway(): TestDispatchGateway {
  const records = new Map<string, GatewayRecord>();
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://gateway.local");
      const path = url.pathname;
      const terminal = /^\/evaluations\/dispatches\/([^/]+)$/.exec(path);
      if (req.method === "GET" && terminal !== null) {
        const record = records.get(decodeURIComponent(terminal[1] ?? ""));
        if (record === undefined) return json(res, 404, { error: "not_found" });
        const digest = url.searchParams.get("binding_digest");
        if (digest !== null && digest !== record.binding_digest) {
          return json(res, 200, { dispatch_id: record.dispatch_id, binding_digest: record.binding_digest, status: "unknown" });
        }
        return json(res, 200, {
          dispatch_id: record.dispatch_id,
          binding_digest: record.binding_digest,
          status: record.status,
          future_execution_blocked: record.future_execution_blocked,
          ...(record.terminal_reason !== undefined ? { terminal_reason: record.terminal_reason } : {}),
          ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
        });
      }
      const action = /^\/dispatch\/([^/]+)\/(not-executed|complete|execute)$/.exec(path);
      if (req.method === "POST" && action !== null) {
        const id = decodeURIComponent(action[1] ?? "");
        const body = await readBody(req);
        const existing = records.get(id);
        if (action[2] === "execute") {
          if (existing !== undefined && existing.future_execution_blocked) {
            return json(res, 409, { dispatch_id: id, error: "already_terminal", future_execution_blocked: true });
          }
          records.set(id, {
            dispatch_id: id,
            binding_digest: String(body.binding_digest ?? ""),
            status: "unknown",
            future_execution_blocked: false,
          });
          return json(res, 202, { dispatch_id: id, accepted: true });
        }
        if (existing !== undefined && existing.future_execution_blocked) {
          return json(res, 409, { dispatch_id: id, error: "already_terminal" });
        }
        if (typeof body.binding_digest !== "string" || body.binding_digest === "") {
          return json(res, 400, { error: "binding_digest_required" });
        }
        if (action[2] === "not-executed") {
          const reason = typeof body.terminal_reason === "string" ? body.terminal_reason.trim() : "";
          if (reason === "") return json(res, 400, { error: "terminal_reason_required" });
          records.set(id, {
            dispatch_id: id,
            binding_digest: body.binding_digest,
            status: "not_executed",
            future_execution_blocked: true,
            terminal_reason: reason,
          });
          return json(res, 200, { dispatch_id: id, status: "not_executed", future_execution_blocked: true });
        }
        const outcome = body.outcome;
        if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
          return json(res, 400, { error: "outcome_required" });
        }
        records.set(id, {
          dispatch_id: id,
          binding_digest: body.binding_digest,
          status: "completed",
          future_execution_blocked: true,
          outcome: outcome as Record<string, unknown>,
        });
        return json(res, 200, { dispatch_id: id, status: "completed", future_execution_blocked: true });
      }
      json(res, 404, { error: "not_found" });
    })().catch((err: unknown) => json(res, 400, { error: err instanceof Error ? err.message : "bad_request" }));
  });
  return {
    server,
    records,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : port);
        });
      });
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
