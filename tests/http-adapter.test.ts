/**
 * kiwi-buyer-http adapter 测试（战略 v2.5 §6.3 单核心多包装）。
 *
 * HTTP 与 MCP 共用同一 buyer-core（buildBuyerService / KiwiBuyerService）；
 * 本测试验证 HTTP 包装暴露的端点语义与 MCP 工具一致（schema/错误分类/幂等）。
 */
import { type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildBuyerService } from "../src/buyer-core/build-service.js";
import { createBuyerHttpServer } from "../src/http/server.js";

const POLICY = {
  policy_id: "dp-http-test",
  version: "1.0",
  principal: "company:http-test",
  expires_at: "2099-12-31T23:59:59Z",
  actions: {
    discover: { mode: "auto" },
    inquiry_rfq: { mode: "auto" },
    compare_offers: { mode: "auto" },
    counter_offer: { mode: "auto" },
    accept_nonbinding: { mode: "ask" },
    handoff: { mode: "ask" },
    payment: { mode: "never" },
  },
  limits: { max_rounds: 3 },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const service = buildBuyerService({
    dbPath: ":memory:",
    principal: "company:http-test",
    buyerAgentId: "buyer-agent:http",
    sessionId: "http-session",
    policy: POLICY,
  });
  server = createBuyerHttpServer({ service });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("kiwi-buyer-http（单核心多包装）", () => {
  it("health", async () => {
    const { status, json } = await call("GET", "/health");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("POST /tasks 创建持久任务（幂等去重）", async () => {
    const intent = {
      intent_id: "http-1",
      intent_type: "purchase",
      items: [{ query: "USB-C 扩展坞", quantity: { value: 10, unit: "个" } }],
    };
    const first = await call("POST", "/tasks", { intent, idempotency_key: "http-k1" });
    expect(first.status).toBe(201);
    const taskId = (first.json.result as { task: { task_id: string } }).task.task_id;
    expect(taskId).toMatch(/^task-/);

    const second = await call("POST", "/tasks", { intent, idempotency_key: "http-k1" });
    expect(second.status).toBe(201);
    expect((second.json.result as { task: { task_id: string } }).task.task_id).toBe(taskId);

    const fetched = await call("GET", `/tasks/${taskId}`);
    expect(fetched.status).toBe(200);
    expect((fetched.json.result as { task: { task_id: string } }).task.task_id).toBe(taskId);
  });

  it("非法 intent → 400 contract_violation（与 MCP 同错误分类）", async () => {
    const { status, json } = await call("POST", "/tasks", {
      intent: { intent_id: "bad", intent_type: "purchase" },
    });
    expect(status).toBe(400);
    expect((json.error as { code: string }).code).toBe("contract_violation");
  });

  it("404 未知路由", async () => {
    const { status } = await call("GET", "/nope");
    expect(status).toBe(404);
  });

  it("POST /approvals 创建持久审批（宿主适配面）", async () => {
    const created = await call("POST", "/tasks", {
      intent: { intent_id: "http-2", intent_type: "purchase", items: [{ query: "硒鼓" }] },
      idempotency_key: "http-k2",
    });
    const taskId = (created.json.result as { task: { task_id: string } }).task.task_id;
    const approval = await call("POST", "/approvals", { task_id: taskId, action: "handoff" });
    expect(approval.status).toBe(201);
    expect((approval.json.result as { approval_id: string }).approval_id).toMatch(/^approval-/);
  });
});
