import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { get, type Server } from "node:http";
import { createMerchantHttpServer, type MerchantHostKernel, type MerchantKernelFactory } from "../src/http/merchant-server.js";
import type { AgentEventSink } from "../src/agent/host/events.js";
import { testProfile } from "./helpers.js";

const profile = testProfile({
  merchant_experience: {
    enabled: true,
    intelligence: true,
    grounding: true,
    presentation: true,
    skills: true,
  },
});

class FakeKernel implements MerchantHostKernel {
  readonly profile = profile;
  readonly principal = {
    principal_id: "merchant-agent:merchant-001",
    owner_id: "merchant-001",
    role: "merchant" as const,
  };
  private readonly sink: AgentEventSink;
  private sequence = 0;
  private pending = [{ candidate_id: "act-1", tool: "update_product", risk: "write_catalog", status: "pending_approval", expires_at: "2099-01-01T00:00:00.000Z" }];

  constructor(sink: AgentEventSink) {
    this.sink = sink;
  }

  async handleUserText(text: string) {
    this.sequence += 1;
    await this.sink.emit({
      eventId: "test-" + this.sequence,
      sessionId: "transport",
      sequence: this.sequence,
      type: "message",
      occurredAt: "2026-09-03T00:00:00.000Z",
      data: { role: "assistant", text: "echo:" + text },
    });
    return { text: "echo:" + text, quit: false };
  }

  listPendingApprovals() {
    return this.pending;
  }

  async approveCandidate(candidateId: string) {
    this.pending = this.pending.filter((candidate) => candidate.candidate_id !== candidateId);
    return { kind: "executed", candidate_id: candidateId };
  }

  rejectCandidate(candidateId: string) {
    const exists = this.pending.some((candidate) => candidate.candidate_id === candidateId);
    if (!exists) return { ok: false, error: "candidate not found" };
    this.pending = this.pending.filter((candidate) => candidate.candidate_id !== candidateId);
    return { ok: true };
  }

  async close() {}
}

let server: Server;
let base: string;
let createdSession: string;

beforeAll(async () => {
  const factory: MerchantKernelFactory = {
    async create(input) {
      return new FakeKernel(input.eventSink);
    },
  };
  server = createMerchantHttpServer({
    profile,
    dataRoot: "/tmp/kiwi-merchant-http-test",
    authenticate: async (request) => {
      if (request.headers.authorization !== "Bearer merchant-test") {
        throw new Error("bad token");
      }
      return { principal_id: "principal-1", merchant_id: "merchant-001" };
    },
    kernelFactory: factory,
    maxEventBuffer: 10,
    maxSessions: 1,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = "http://127.0.0.1:" + (typeof address === "object" && address !== null ? address.port : 0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(method: string, route: string, body?: unknown, token = "merchant-test") {
  const response = await fetch(base + route, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

function readSseUntil(route: string, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = get(base + route, { headers: { authorization: "Bearer merchant-test" } }, (response) => {
      response.setEncoding("utf8");
      let data = "";
      response.on("data", (chunk: string) => {
        data += chunk;
        if (!settled && data.includes(expected)) {
          settled = true;
          resolve(data);
          req.destroy();
        }
      });
      response.on("error", (error) => {
        if (!settled) reject(error);
      });
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function parseSseFrames(raw: string): Array<Record<string, string>> {
  return raw
    .split("\n\n")
    .filter((frame) => frame.trim() !== "")
    .map((frame) => Object.fromEntries(
      frame.split("\n").filter((line) => line.includes(": ")).map((line) => {
        const separator = line.indexOf(": ");
        return [line.slice(0, separator), line.slice(separator + 2)];
      }),
    ));
}

describe("kiwi-merchant-http", () => {
  it("requires authentication and creates an isolated Merchant session", async () => {
    const unauthorized = await call("POST", "/v1/merchant/sessions", undefined, "wrong");
    expect(unauthorized.status).toBe(401);

    const created = await call("POST", "/v1/merchant/sessions");
    expect(created.status).toBe(201);
    createdSession = String(created.json.session_id);
    expect(createdSession.length).toBeGreaterThan(20);
    expect(created.json.events_url).toBe("/v1/merchant/sessions/" + createdSession + "/events");
  });

  it("serializes a message through the Kernel and exposes pending action metadata", async () => {
    const result = await call("POST", "/v1/merchant/sessions/" + createdSession + "/messages", {
      message: "最近有什么需要处理？",
    });
    expect(result.status).toBe(200);
    expect(result.json.reply).toBe("echo:最近有什么需要处理？");
    expect(result.json.pending_actions).toMatchObject([{ candidate_id: "act-1", stale_sensitive: true }]);
  });

  it("caps concurrent sessions", async () => {
    const limited = await call("POST", "/v1/merchant/sessions");
    expect(limited.status).toBe(429);
    expect((limited.json.error as { code: string }).code).toBe("session_limit_reached");
  });

  it("replays events with after and does not expose a different merchant session", async () => {
    const events = await readSseUntil(
      "/v1/merchant/sessions/" + createdSession + "/events?after=0",
      "echo:最近有什么需要处理？",
    );
    const messageFrame = parseSseFrames(events).find((frame) => frame.event === "message");
    expect(messageFrame?.id).toBe("1");
    expect(JSON.parse(messageFrame?.data ?? "{}")).toMatchObject({ data: { text: "echo:最近有什么需要处理？" } });

    const forbidden = await call("GET", "/v1/merchant/sessions/" + createdSession, undefined, "other-token");
    expect(forbidden.status).toBe(401);
  });

  it("routes approval actions to the existing Kernel methods", async () => {
    const approved = await call(
      "POST",
      "/v1/merchant/sessions/" + createdSession + "/approvals/act-1",
      { action: "approve" },
    );
    expect(approved.status).toBe(200);
    expect(approved.json.result).toMatchObject({ kind: "executed", candidate_id: "act-1" });

    const missing = await call(
      "POST",
      "/v1/merchant/sessions/" + createdSession + "/approvals/act-1",
      { action: "reject" },
    );
    expect(missing.status).toBe(409);
  });

  it("rejects malformed messages and supports session deletion", async () => {
    const invalid = await call("POST", "/v1/merchant/sessions/" + createdSession + "/messages", { message: "" });
    expect(invalid.status).toBe(400);

    const deleted = await call("DELETE", "/v1/merchant/sessions/" + createdSession);
    expect(deleted.status).toBe(200);
    const gone = await call("GET", "/v1/merchant/sessions/" + createdSession);
    expect(gone.status).toBe(404);
  });

  it("expires an idle session on the next request", async () => {
    let now = 1_000;
    const local = createMerchantHttpServer({
      profile,
      dataRoot: "/tmp/kiwi-merchant-http-expiry-test",
      authenticate: async () => ({ principal_id: "principal-ttl", merchant_id: "merchant-001" }),
      kernelFactory: {
        async create(input) {
          return new FakeKernel(input.eventSink);
        },
      },
      sessionIdleTtlMs: 1_000,
      nowMs: () => now,
    });
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    const address = local.address();
    const localBase = "http://127.0.0.1:" + (typeof address === "object" && address !== null ? address.port : 0);
    try {
      const created = await fetch(localBase + "/v1/merchant/sessions", { method: "POST" });
      const payload = (await created.json()) as { session_id: string };
      now += 1_001;
      await fetch(localBase + "/health");
      const expired = await fetch(localBase + "/v1/merchant/sessions/" + payload.session_id);
      expect(expired.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it("reserves a session slot while kernel creation is pending", async () => {
    let release!: () => void;
    let started!: () => void;
    const creationStarted = new Promise<void>((resolve) => { started = resolve; });
    const creationRelease = new Promise<void>((resolve) => { release = resolve; });
    const local = createMerchantHttpServer({
      profile,
      dataRoot: "/tmp/kiwi-merchant-http-concurrency-test",
      authenticate: async () => ({ principal_id: "principal-concurrency", merchant_id: "merchant-001" }),
      maxSessions: 1,
      kernelFactory: {
        async create(input) {
          started();
          await creationRelease;
          return new FakeKernel(input.eventSink);
        },
      },
    });
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    const address = local.address();
    const localBase = "http://127.0.0.1:" + (typeof address === "object" && address !== null ? address.port : 0);
    try {
      const first = fetch(localBase + "/v1/merchant/sessions", { method: "POST" });
      await creationStarted;
      const second = await fetch(localBase + "/v1/merchant/sessions", { method: "POST" });
      expect(second.status).toBe(429);
      release();
      expect((await first).status).toBe(201);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it("keeps health checks successful when idle kernel cleanup fails", async () => {
    let now = 1_000;
    const local = createMerchantHttpServer({
      profile,
      dataRoot: "/tmp/kiwi-merchant-http-cleanup-test",
      authenticate: async () => ({ principal_id: "principal-cleanup", merchant_id: "merchant-001" }),
      sessionIdleTtlMs: 1_000,
      nowMs: () => now,
      kernelFactory: {
        async create(input) {
          const kernel = new FakeKernel(input.eventSink);
          kernel.close = async () => { throw new Error("close failed"); };
          return kernel;
        },
      },
    });
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    const address = local.address();
    const localBase = "http://127.0.0.1:" + (typeof address === "object" && address !== null ? address.port : 0);
    try {
      const created = await fetch(localBase + "/v1/merchant/sessions", { method: "POST" });
      expect(created.status).toBe(201);
      now += 1_001;
      const health = await fetch(localBase + "/health");
      expect(health.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });
});
