import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { buildBuyerService } from "../src/buyer-core/build-service.js";
import { McpServer } from "../src/mcp/server.js";
import { buildKiwiTools } from "../src/mcp/tools.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import type { TermSet } from "../src/negotiation/domain/common.js";

const dirs: string[] = [];
const servers: Array<http.Server> = [];
const rawResults: Array<Record<string, unknown>> = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiwi-rfq-dispatch-state-"));
  dirs.push(dir);
  return dir;
}

function findWire(value: unknown): NegotiationEnvelope | undefined {
  if (!value || typeof value !== "object") return undefined;
  if ("knp_envelope" in value) return (value as { knp_envelope: NegotiationEnvelope }).knp_envelope;
  for (const child of Object.values(value)) {
    const found = findWire(child);
    if (found) return found;
  }
  return undefined;
}

function fixture() {
  let failQuery = false;
  let dropA2aResponse = false;
  let queryFailureCount = 0;
  let a2aSendCount = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const queryFailurePath = [
      "/v1/agents/search",
      "/v1/listings/search",
      "/v1/merchant-publications/search",
    ].includes(url.pathname);
    if (failQuery && url.searchParams.get("q") === "thermos" && queryFailurePath) {
      queryFailureCount += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"synthetic test failure"}');
      return;
    }
    if (url.pathname === "/v1/agents/search") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [agentRecord(`http://127.0.0.1:${address.port}`)] }));
      return;
    }
    if (
      url.pathname === "/v1/listings/search" ||
      url.pathname === "/v1/merchant-publications/search"
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
      return;
    }
    if (url.pathname === "/card") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          supportedInterfaces: [
            { protocolBinding: "JSONRPC", url: `http://127.0.0.1:${address.port}/rpc` },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/rpc") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const wire = findWire(body);
        if (!wire) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { task: { id: "poll-task", status: { state: "working" } } },
            }),
          );
          return;
        }
        a2aSendCount += 1;
        if (dropA2aResponse) {
          // Simulate a remote effect followed by a lost response. The server records
          // receipt of the wire before closing the socket, so the caller must treat
          // the result as unknown rather than known-not-sent.
          res.destroy();
          return;
        }
        const reply = finalizeEnvelope({
          capability: wire.capability,
          protocol_version: wire.protocol_version,
          negotiation_id: wire.negotiation_id,
          exchange_id: "exchange-reply",
          message_id: `reply-${wire.message_id}`,
          in_reply_to: wire.message_id,
          actor: "merchant",
          action: "offer",
          created_at: new Date().toISOString(),
          payload: {
            type: "offer",
            offer_id: "offer-local",
            terms: {
              currency: "CNY",
              items: [
                {
                  sku: "thermos",
                  quantity: { value: 1, unit: "unit" },
                  unit_price: { currency: "CNY", amount_minor: 100 },
                },
              ],
              total_price: { currency: "CNY", amount_minor: 100 },
            } as TermSet,
          },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              task: {
                id: "remote-task-local",
                contextId: "remote-context-local",
                status: {
                  state: "completed",
                  message: {
                    role: "agent",
                    messageId: reply.message_id,
                    parts: [{ kind: "data", data: { knp_envelope: reply } }],
                  },
                },
              },
            },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  let address: { port: number };
  const ready = new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const bound = server.address();
      if (!bound || typeof bound === "string") throw new Error("expected loopback TCP address");
      address = { port: bound.port };
      resolve();
    });
  });
  const agentRecord = (baseUrl: string) => ({
    catalog_agent_id: "catalog-agent-local",
    principal_type: "merchant",
    merchant_id: "merchant-local",
    display_name: "Local Test Merchant",
    canonical_domain: "merchant.invalid",
    agent_card_url: `${baseUrl}/card`,
    hosting_mode: "direct",
    verification_level: "commerce_verified",
    freshness_state: "fresh",
    administrative_state: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    capabilities: ["catalog"],
  });
  return {
    ready,
    get baseUrl() {
      return `http://127.0.0.1:${address.port}`;
    },
    armQueryFailure() {
      failQuery = true;
    },
    dropResponses() {
      dropA2aResponse = true;
    },
    counts() {
      return { queryFailureCount, a2aSendCount };
    },
  };
}

const policy = {
  policy_id: "policy-rfq-test",
  version: "1.0",
  principal: "principal:test",
  expires_at: "2099-12-31T23:59:59Z",
  actions: {
    discover: { mode: "auto" },
    inquiry_rfq: { mode: "auto" },
    compare_offers: { mode: "auto" },
    counter_offer: { mode: "auto" },
    accept_nonbinding: { mode: "ask" },
    handoff: { mode: "never" },
    payment: { mode: "never" },
  },
  limits: { max_rounds: 2 },
};

async function makeMcp(f: ReturnType<typeof fixture>, dir: string) {
  await f.ready;
  const service = buildBuyerService({
    dbPath: path.join(dir, "buyer.sqlite"),
    principal: "principal:test",
    buyerAgentId: "buyer:test",
    sessionId: "session:test",
    policy,
    catalogUrl: f.baseUrl,
    protocolStateDir: path.join(dir, "protocol"),
    a2aAllowPrivateRanges: true,
    a2aSkipDnsCheck: true,
    a2aTimeoutMs: 250,
  });
  const server = new McpServer({
    tools: buildKiwiTools(service),
    serverInfo: { name: "rfq-repair-test", version: "1" },
  });
  await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    }),
  );
  await server.handleMessage(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  const call = async (id: number, name: string, args: Record<string, unknown>) => {
    const response = await server.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    );
    return response?.result as { content: Array<{ text: string }>; isError?: boolean };
  };
  const search = async () => call(2, "kiwi_search", { query: "thermos" });
  const request = (idempotencyKey: string) =>
    call(3, "kiwi_request_quotes", {
      intent: {
        intent_id: "intent-local",
        intent_type: "inquiry",
        items: [{ query: "thermos", quantity: { value: 1, unit: "unit" } }],
      },
      merchant_ids: ["merchant-local"],
      idempotency_key: idempotencyKey,
    });
  return { call, search, request, service };
}

async function closeServers() {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(async () => {
  await closeServers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  const output = process.env.KIWI_RFQ_REPAIR_RAW_PATH;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(
      output,
      JSON.stringify(
        { schema: "kiwi.rfq-dispatch-state-test-raw/1", results: rawResults },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
});

it("marks post-commit Catalog failure known-not-sent and same-key retry does not redispatch", async () => {
  const f = fixture();
  const mcp = await makeMcp(f, tempDir());
  expect((await mcp.search()).isError).not.toBe(true);
  f.armQueryFailure();
  const firstText = (await mcp.request("catalog-failure-key")).content[0]!.text;
  const first = JSON.parse(firstText) as { task: Record<string, unknown>; created: boolean };
  const firstTaskId = String(first.task.task_id);
  const firstCandidate = (first.task.candidates as Array<Record<string, unknown>>)[0]!;
  const firstCounts = f.counts();
  expect(first.task.status).toBe("failed");
  expect(first.task.resumable).toBe(false);
  expect(firstCandidate.status).toBe("failed");
  expect(firstCandidate.retryable).toBe(true);
  expect((firstCandidate.failure as Record<string, unknown>).detail).toContain("no RFQ was sent");
  expect(firstCounts.a2aSendCount).toBe(0);

  const secondText = (await mcp.request("catalog-failure-key")).content[0]!.text;
  const second = JSON.parse(secondText) as { task: Record<string, unknown>; created: boolean };
  const secondCounts = f.counts();
  expect(second.task.task_id).toBe(firstTaskId);
  expect(second.task.status).toBe("failed");
  expect(second.created).toBe(false);
  expect(secondCounts.a2aSendCount).toBe(0);
  expect(secondCounts.queryFailureCount).toBe(firstCounts.queryFailureCount);
  rawResults.push({
    case: "catalog-failure",
    first: {
      status: first.task.status,
      resumable: first.task.resumable,
      candidate: firstCandidate,
      counts: firstCounts,
    },
    retry: {
      status: second.task.status,
      resumable: second.task.resumable,
      created: second.created,
      counts: secondCounts,
    },
  });
});

it("persists a normal RFQ success and same-key retry returns it without another A2A send", async () => {
  const f = fixture();
  const mcp = await makeMcp(f, tempDir());
  expect((await mcp.search()).isError).not.toBe(true);
  const first = JSON.parse((await mcp.request("normal-success-key")).content[0]!.text) as {
    task: Record<string, unknown>;
    created: boolean;
  };
  const firstCounts = f.counts();
  const second = JSON.parse((await mcp.request("normal-success-key")).content[0]!.text) as {
    task: Record<string, unknown>;
    created: boolean;
  };
  const secondCounts = f.counts();
  expect(first.task.status).toBe("succeeded");
  expect((first.task.candidates as Array<Record<string, unknown>>)[0]!.status).toBe("succeeded");
  expect(firstCounts.a2aSendCount).toBe(1);
  expect(second.task.task_id).toBe(first.task.task_id);
  expect(second.created).toBe(false);
  expect(secondCounts.a2aSendCount).toBe(1);
  rawResults.push({
    case: "normal-success",
    first: { status: first.task.status, resumable: first.task.resumable, counts: firstCounts },
    retry: {
      status: second.task.status,
      resumable: second.task.resumable,
      created: second.created,
      counts: secondCounts,
    },
  });
});

it("records lost A2A response as unknown/non-retryable and same-key retry never resends", async () => {
  const f = fixture();
  const mcp = await makeMcp(f, tempDir());
  expect((await mcp.search()).isError).not.toBe(true);
  f.dropResponses();
  const first = JSON.parse((await mcp.request("unknown-send-key")).content[0]!.text) as {
    task: Record<string, unknown>;
    created: boolean;
  };
  const firstCandidate = (first.task.candidates as Array<Record<string, unknown>>)[0]!;
  const firstFailure = firstCandidate.failure as Record<string, unknown>;
  const firstCounts = f.counts();
  expect(first.task.status).toBe("in_progress");
  expect(first.task.resumable).toBe(true);
  expect(firstCandidate.status).toBe("failed");
  expect(firstFailure.retryable).toBe(false);
  expect(String(firstFailure.detail)).toMatch(/unknown|confirmed result/i);
  expect(firstCounts.a2aSendCount).toBe(1);

  const second = JSON.parse((await mcp.request("unknown-send-key")).content[0]!.text) as {
    task: Record<string, unknown>;
    created: boolean;
  };
  const secondCounts = f.counts();
  expect(second.task.task_id).toBe(first.task.task_id);
  expect(second.task.status).toBe("in_progress");
  expect(second.created).toBe(false);
  expect(secondCounts.a2aSendCount).toBe(1);
  rawResults.push({
    case: "lost-a2a-response",
    first: {
      status: first.task.status,
      resumable: first.task.resumable,
      candidate: firstCandidate,
      counts: firstCounts,
    },
    retry: {
      status: second.task.status,
      resumable: second.task.resumable,
      created: second.created,
      counts: secondCounts,
    },
  });
});


it("a thrown send remains unknown and same-key recovery reads state without resending", async () => {
  const f = fixture();
  const mcp = await makeMcp(f, tempDir());
  expect((await mcp.search()).isError).not.toBe(true);
  let sendAttempts = 0;
  let recoveryReads = 0;
  const internal = mcp.service as unknown as Record<string, unknown>;
  internal.quoteFetcher = {
    requestQuotes: async () => {
      sendAttempts += 1;
      throw new Error("synthetic post-send transport exception");
    },
    recoverQuotes: async () => {
      recoveryReads += 1;
      return [];
    },
  };
  const first = JSON.parse((await mcp.request("throw-after-send-key")).content[0]!.text) as {
    task: Record<string, unknown>;
    created: boolean;
  };
  const firstCandidate = (first.task.candidates as Array<Record<string, unknown>>)[0]!;
  expect(first.task.status).toBe("in_progress");
  expect(first.task.resumable).toBe(true);
  expect(firstCandidate.retryable).toBe(false);
  expect(String((firstCandidate.failure as Record<string, unknown>).detail)).toContain("outcome is unknown");
  expect(sendAttempts).toBe(1);

  const second = JSON.parse((await mcp.request("throw-after-send-key")).content[0]!.text) as {
    task: Record<string, unknown>;
    created: boolean;
  };
  const readback = JSON.parse((await mcp.call(4, "kiwi_get_task", { task_id: first.task.task_id })).content[0]!.text) as {
    task: Record<string, unknown>;
  };
  expect(second.task.task_id).toBe(first.task.task_id);
  expect(second.created).toBe(false);
  expect(recoveryReads).toBe(1);
  expect(sendAttempts).toBe(1);
  expect(readback.task.status).toBe("in_progress");
  expect((readback.task.candidates as Array<Record<string, unknown>>)[0]!.retryable).toBe(false);
  rawResults.push({
    case: "throw-after-send",
    first: { status: first.task.status, resumable: first.task.resumable, candidate: firstCandidate, sendAttempts },
    retry: { status: second.task.status, created: second.created, recoveryReads, sendAttempts },
    readback: { status: readback.task.status, candidates: readback.task.candidates },
  });
});
