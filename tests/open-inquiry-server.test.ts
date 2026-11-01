import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { A2AServer, A2AServerThrottle } from "../src/a2a/server/index.js";
import { echoHandler } from "../src/a2a/server/handler.js";
import { createA2aAuthVerifier } from "../src/a2a/node.js";
import { InquiryNonceStore } from "../src/a2a/inquiry-nonce-store.js";
import { OpenInquirySessionSigner } from "../src/a2a/open-inquiry-session.js";
import { createOpenInquiryTransport } from "../src/a2a/client/open-inquiry-transport.js";
import { buildA2AClient } from "../src/buyer-core/a2a-knp.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { validEnvelopeFields } from "./negotiation-helpers.js";

describe("open inquiry server isolation", () => {
  it("routes a real account-free buyer client through the directory to the merchant", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-open-relay-"));
    const nonces = new InquiryNonceStore(dir);
    const origin = "https://merchant.example";
    const server = new A2AServer({ card: () => ({ name: "Shop", description: "test", providerOrganization: "test",
      version: "1.0.0", baseUrl: origin, a2aPath: "/a2a" }),
    ledger: new LedgerStore({ dir: path.join(dir, "ledger") }),
    idempotency: new IdempotencyStore({ dir: path.join(dir, "idem") }), handler: echoHandler(),
    authVerifier: createA2aAuthVerifier({ mode: "signature", signingKeyDir: dir, signingKeyId: origin,
      advertisedBase: origin, authoritySource: "declared", openInquiryNonceStore: nonces }) });
    const httpServer = server.createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/a2a`;
    const calls: string[] = [];
    const relay: typeof fetch = async (input, init) => {
      calls.push(String(input));
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      return fetch(address, init);
    };
    const transport = createOpenInquiryTransport({ catalogOrigin: "https://catalog.example",
      catalogAgentId: "cagt_test", merchantEndpoint: `${origin}/a2a`, fetchImpl: relay });
    const client = buildA2AClient(`${origin}/a2a`, { signer: new OpenInquirySessionSigner(),
      skipDnsCheck: true, fetchImpl: transport });
    try {
      const task = await client.sendMessage({ role: "user", messageId: "buyer-no-account",
        parts: [{ kind: "text", text: "Please quote this item" }] });
      expect(task.id).toBeTruthy();
      expect((await client.getTask(task.id)).id).toBe(task.id);
      expect(calls).toEqual(Array(2).fill("https://catalog.example/v1/agents/cagt_test/public-inquiry"));
    } finally {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      nonces.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("allows an opt-in session to read only its own task and rejects replay and privileged methods", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-open-inquiry-"));
    const nonceStore = new InquiryNonceStore(dir);
    const origin = "https://merchant.example";
    const verifier = createA2aAuthVerifier({ mode: "signature", signingKeyDir: dir,
      signingKeyId: origin, advertisedBase: origin, authoritySource: "declared", openInquiryNonceStore: nonceStore });
    const server = new A2AServer({ card: () => ({ name: "Shop", description: "test", providerOrganization: "test",
      version: "1.0.0", baseUrl: origin, a2aPath: "/a2a" }),
    ledger: new LedgerStore({ dir: path.join(dir, "ledger") }),
    idempotency: new IdempotencyStore({ dir: path.join(dir, "idem") }), authVerifier: verifier, handler: echoHandler() });
    const httpServer = server.createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/a2a`;
    const cardResponse = await fetch(address.replace("/a2a", "/.well-known/agent-card.json"));
    const card = await cardResponse.json() as { capabilities?: { extensions?: Array<{ uri: string }> } };
    const extension = card.capabilities?.extensions?.[0]?.uri;
    const first = new OpenInquirySessionSigner();
    const second = new OpenInquirySessionSigner();
    const rpc = async (signer: OpenInquirySessionSigner, method: string, params: unknown) => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
      const headers = { "content-type": "application/json", "a2a-version": "1.0",
        ...(extension ? { "a2a-extensions": extension } : {}),
        ...signer.sign({ method: "POST", url: `${origin}/a2a`, body, headers: {} }) };
      const response = await fetch(address, { method: "POST", body, headers });
      return { response, body: await response.json() as Record<string, unknown>, rawBody: body, headers };
    };
    try {
      const created = await rpc(first, "SendMessage", { message: { role: "ROLE_USER",
        parts: [{ text: "hello" }], messageId: "open-owner-1" } });
      expect(created.response.status).toBe(200);
      const task = (created.body["result"] as { task: { id: string } }).task.id;
      expect(typeof task).toBe("string");
      const own = await rpc(first, "GetTask", { id: task });
      expect(JSON.stringify(own.body)).toContain(task);
      const other = await rpc(second, "GetTask", { id: task });
      expect((other.body["error"] as { code: number }).code).toBe(-32001);
      expect(other.body["result"]).toBeUndefined();
      const envelope = finalizeEnvelope({ ...validEnvelopeFields(), message_id: "open-inquiry-knp-1" });
      const inquiry = await rpc(first, "SendMessage", { message: { role: "ROLE_USER", messageId: "open-inquiry-knp-1",
        parts: [{ data: { knp_envelope: envelope }, mediaType: "application/json" }] } });
      expect(inquiry.response.status).toBe(200);
      const inquiryTask = (inquiry.body["result"] as { task: { id: string } }).task.id;
      expect(typeof inquiryTask).toBe("string");
      expect((await rpc(second, "GetTask", { id: inquiryTask })).body["result"]).toBeUndefined();
      expect((await rpc(first, "GetExtendedAgentCard", {})).response.status).toBe(403);
      const replay = await fetch(address, { method: "POST", body: created.rawBody, headers: created.headers });
      expect(replay.status).toBe(403);
    } finally {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      nonceStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps buyer limits separate while bounding the shared gateway source", () => {
    const throttle = new A2AServerThrottle({ unverifiedIdentityScale: 0.5, tiers: { T0: {
      identityRequestsPerWindow: 2, domainRequestsPerWindow: 10, maxConcurrentTasks: 2,
      malformedBudget: 5, retryAfterSeconds: 1,
    } } });
    const one = new OpenInquirySessionSigner();
    const two = new OpenInquirySessionSigner();
    expect(throttle.check({ identity: one.keyid, remoteAddress: "192.0.2.1", identityVerified: true, trustLevel: "T0" }).allowed).toBe(true);
    expect(throttle.check({ identity: two.keyid, remoteAddress: "192.0.2.1", identityVerified: true, trustLevel: "T0" }).allowed).toBe(true);
    for (let i = 0; i < 118; i++) {
      const session = new OpenInquirySessionSigner();
      expect(throttle.check({ identity: session.keyid, remoteAddress: "192.0.2.1", identityVerified: true, trustLevel: "T0" }).allowed).toBe(true);
    }
    const next = new OpenInquirySessionSigner();
    expect(throttle.check({ identity: next.keyid, remoteAddress: "192.0.2.1", identityVerified: true, trustLevel: "T0" }).allowed).toBe(false);
  });
});
