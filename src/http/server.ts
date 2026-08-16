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
 * kiwi-buyer-http —— Buyer Core 的 HTTP 包装（战略 v2.5 §6.3/§6.5/Appendix A）。
 *
 * 与 MCP 同一 buyer-core（KiwiBuyerService），不同包装：证明"单核心、多包装"——
 * 未来新宿主出现时接入从"重写产品"降为"写一个薄适配器"（§6.3）。
 *
 * 暴露与 7 个 MCP 工具一一对应的 HTTP 端点（同一语义不变量：schema/授权门/
 * 幂等/错误分类）。本 server 不持有任何商业状态——状态唯一权威在持久 store。
 */

import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { KiwiBuyerService, type AuthorizationRecord } from "../buyer-core/service.js";
import { McpError } from "../buyer-core/errors.js";
import { buildMerchantUcpProfile } from "../merchant/ucp-profile.js";
import type { MerchantOpsService } from "../merchant/ops.js";

export interface HttpAdapterOptions {
  service: KiwiBuyerService;
  /** 商家 UCP Profile 发布配置：merchantId → { domain, catalogEndpoint }（§7.1）。 */
  merchantUcp?: Record<string, { domain: string; catalogEndpoint: string }>;
  /** Merchant Ops（§7.6）：merchantId → MerchantOpsService（merchant token 作用域）。 */
  merchantOps?: Record<string, MerchantOpsService>;
}

type Params = Record<string, string>;

interface RouteHandler {
  (body: Record<string, unknown>, params: Params, res: ServerResponse): Promise<void>;
}

export function createBuyerHttpServer(options: HttpAdapterOptions): Server {
  const { service, merchantUcp, merchantOps } = options;

  const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 256 * 1024) reject(new Error("request body too large"));
      });
      req.on("end", () => {
        if (data.trim() === "") return resolve({});
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          reject(new Error("invalid JSON body"));
        }
      });
      req.on("error", reject);
    });

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const sendError = (res: ServerResponse, error: unknown): void => {
    if (error instanceof McpError) {
      return send(res, 400, { ok: false, error: { code: error.code, message: error.message } });
    }
    return send(res, 500, {
      ok: false,
      error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) },
    });
  };

  const routes: Array<{ method: string; path: string; handler: RouteHandler }> = [
    { method: "GET", path: "/health", handler: async (_b, _p, res) => send(res, 200, { ok: true, service: "kiwi-buyer-http" }) },
    {
      method: "POST", path: "/search", handler: async (b, _p, res) => {
        try {
          const result = await service.search({
            query: String(b.query ?? ""),
            category: b.category === undefined ? undefined : String(b.category),
            region: b.region === undefined ? undefined : String(b.region),
          });
          send(res, 200, { ok: true, result });
        } catch (e) { sendError(res, e); }
      },
    },
    {
      method: "POST", path: "/tasks", handler: async (b, _p, res) => {
        try {
          const result = await service.requestQuotes({
            intent: (b.intent ?? {}) as Record<string, unknown>,
            idempotency_key: b.idempotency_key === undefined ? undefined : String(b.idempotency_key),
            merchant_ids: b.merchant_ids === undefined ? undefined : (b.merchant_ids as string[]).map(String),
          });
          send(res, 201, { ok: true, result });
        } catch (e) { sendError(res, e); }
      },
    },
    {
      method: "GET", path: "/tasks/:id", handler: async (_b, p, res) => {
        try { send(res, 200, { ok: true, result: service.getTask(p.id ?? "") }); }
        catch (e) { sendError(res, e); }
      },
    },
    {
      method: "POST", path: "/tasks/:id/negotiate", handler: async (b, p, res) => {
        try {
          const result = await service.negotiate({
            task_id: p.id ?? "",
            action: b.action === "clarification" ? "clarification" : "counter_offer",
            summary: String(b.summary ?? ""),
          });
          send(res, 200, { ok: true, result });
        } catch (e) { sendError(res, e); }
      },
    },
    {
      method: "POST", path: "/tasks/:id/agreement", handler: async (b, p, res) => {
        try {
          const result = await service.acceptAgreement({
            task_id: p.id ?? "",
            candidate_id: String(b.candidate_id ?? ""),
            approval_id: b.approval_id === undefined ? undefined : String(b.approval_id),
          });
          send(res, 201, {
            ok: true,
            result: { agreement: result.agreement, authorization: result.authorization },
          });
        } catch (e) { sendError(res, e); }
      },
    },
    {
      method: "GET", path: "/agreements/:id", handler: async (_b, p, res) => {
        try { send(res, 200, { ok: true, result: service.getAgreement(p.id ?? "") }); }
        catch (e) { sendError(res, e); }
      },
    },
    {
      method: "POST", path: "/agreements/:id/handoff", handler: async (b, p, res) => {
        try {
          const result = await service.handoff({
            agreement_id: p.id ?? "",
            approval_id: String(b.approval_id ?? ""),
            destination_type: String(b.destination_type ?? ""),
            url: b.url === undefined ? undefined : String(b.url),
          });
          send(res, 200, { ok: true, result });
        } catch (e) { sendError(res, e); }
      },
    },
    {
      method: "POST", path: "/approvals", handler: async (b, _p, res) => {
        try {
          const result = service.requestApproval({
            task_id: String(b.task_id ?? ""),
            action: b.action as "accept_nonbinding" | "handoff" | "sensitive_disclosure",
            candidate_digest: b.candidate_digest === undefined ? undefined : String(b.candidate_digest),
          });
          send(res, 201, { ok: true, result });
        } catch (e) { sendError(res, e); }
      },
    },
    {
      // Merchant Ops RFQ 队列（§7.6）：kiwi.merchant.rfqs。
      method: "GET", path: "/merchant/:id/rfqs", handler: async (_b, p, res) => {
        const ops = merchantOps?.[p.id ?? ""];
        if (ops === undefined) return send(res, 404, { ok: false, error: { code: "merchant_not_found", message: `no ops for ${p.id}` } });
        try { send(res, 200, { ok: true, result: await ops.listRfqQueue(p.id ?? "") }); }
        catch (e) { sendError(res, e); }
      },
    },
    {
      // Merchant Ops human_required（§7.6）：kiwi.merchant.reviews。
      method: "GET", path: "/merchant/:id/human-review", handler: async (_b, p, res) => {
        const ops = merchantOps?.[p.id ?? ""];
        if (ops === undefined) return send(res, 404, { ok: false, error: { code: "merchant_not_found", message: `no ops for ${p.id}` } });
        try { send(res, 200, { ok: true, result: await ops.listHumanReview(p.id ?? "") }); }
        catch (e) { sendError(res, e); }
      },
    },
    {
      // Merchant Ops analytics（§7.6）：kiwi.merchant.analytics。
      method: "GET", path: "/merchant/:id/analytics", handler: async (_b, p, res) => {
        const ops = merchantOps?.[p.id ?? ""];
        if (ops === undefined) return send(res, 404, { ok: false, error: { code: "merchant_not_found", message: `no ops for ${p.id}` } });
        try { send(res, 200, { ok: true, result: await ops.analytics(p.id ?? "") }); }
        catch (e) { sendError(res, e); }
      },
    },
    {
      // Merchant Ops 处理 human_required（§7.6）：kiwi.merchant.approve。
      method: "POST", path: "/merchant/:id/resolve-review", handler: async (b, p, res) => {
        const ops = merchantOps?.[p.id ?? ""];
        if (ops === undefined) return send(res, 404, { ok: false, error: { code: "merchant_not_found", message: `no ops for ${p.id}` } });
        try {
          const result = await ops.resolveReview(p.id ?? "", String(b.conversation_id ?? ""), String(b.decision ?? "approve"));
          send(res, 200, { ok: true, result });
        } catch (e) { sendError(res, e); }
      },
    },
    {
      // Merchant UCP Profile 发布（§7.1 Protocol Publishing）：返回 `/.well-known/ucp`。
      method: "GET", path: "/merchants/:id/ucp", handler: async (_b, p, res) => {
        const mid = p.id ?? "";
        const config = merchantUcp?.[mid];
        if (config === undefined) {
          return send(res, 404, { ok: false, error: { code: "merchant_not_found", message: `no UCP config for ${mid}` } });
        }
        try {
          const profile = buildMerchantUcpProfile({ domain: config.domain, merchantId: mid, catalogEndpoint: config.catalogEndpoint });
          send(res, 200, { ok: true, ucp: profile });
        } catch (e) { sendError(res, e); }
      },
    },
    {
      method: "POST", path: "/approvals/:id/approve", handler: async (b, p, res) => {
        try {
          service.approveApproval({
            approval_id: p.id ?? "",
            authorization: (b.authorization ?? {}) as AuthorizationRecord,
          });
          send(res, 200, { ok: true });
        } catch (e) { sendError(res, e); }
      },
    },
  ];

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const segments = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    for (const route of routes) {
      const routeSegments = route.path.split("/").filter(Boolean);
      if (routeSegments.length !== segments.length || route.method !== method) continue;
      let match = true;
      const params: Params = {};
      for (let i = 0; i < routeSegments.length; i += 1) {
        const rs = routeSegments[i] as string;
        const ss = segments[i] as string;
        if (rs.startsWith(":")) params[rs.slice(1)] = ss;
        else if (rs !== ss) { match = false; break; }
      }
      if (!match) continue;
      const body = await readJson(req).catch(() => ({}));
      await route.handler(body, params, res);
      return;
    }
    send(res, 404, { ok: false, error: { code: "not_found", message: `${method} ${url.pathname}` } });
  });
}

export type { Server };
