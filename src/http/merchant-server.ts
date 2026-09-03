/**
 * Merchant Experience HTTP/SSE host adapter.
 *
 * This adapter owns transport sessions and event replay only. Merchant business
 * state remains in AgentKernel, WriteApprovalCandidateStore, Ledger and the
 * configured backend.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { buildChatKernel } from "../agent/kernel-builder.js";
import type { KernelReply } from "../agent/kernel.js";
import type { AgentEventSink, AgentHostEvent } from "../agent/host/events.js";
import type { AgentProfile } from "../config/profile.js";
import type { MerchantAnalyticsSource } from "../agent/merchant/intelligence/types.js";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_EVENT_BUFFER = 200;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGE_CHARS = 20_000;

export interface MerchantHostIdentity {
  principal_id: string;
  merchant_id: string;
}

export interface MerchantHostKernel {
  profile: AgentProfile;
  principal: { principal_id: string; owner_id: string; role: "buyer" | "merchant" };
  handleUserText(text: string): Promise<KernelReply>;
  listPendingApprovals(): Array<{
    candidate_id: string;
    tool: string;
    risk: string;
    status: string;
    expires_at: string;
  }>;
  approveCandidate(candidateId: string): Promise<unknown>;
  rejectCandidate(candidateId: string): { ok: boolean; error?: string };
  close(): Promise<void>;
}

export interface MerchantKernelFactory {
  create(input: {
    dataDir: string;
    eventSink: AgentEventSink;
    eventSessionId: string;
  }): Promise<MerchantHostKernel>;
}

export interface MerchantHttpAdapterOptions {
  /** Only Merchant profiles are accepted. */
  profile: AgentProfile;
  /** Per-transport-session root. A generated session id is always appended. */
  dataRoot: string;
  catalog?: string;
  /** Required authentication hook. Never trust merchant_id from the request body. */
  authenticate(request: IncomingMessage): Promise<MerchantHostIdentity>;
  kernelFactory?: MerchantKernelFactory;
  maxEventBuffer?: number;
  maxBodyBytes?: number;
  maxSessions?: number;
  sessionIdleTtlMs?: number;
  /** Injectable monotonic wall clock for deterministic expiry tests. */
  nowMs?: () => number;
  /** Optional server-owned sales/campaign/ROAS authority. */
  analyticsSource?: MerchantAnalyticsSource;
}

interface SessionRecord {
  sessionId: string;
  identity: MerchantHostIdentity;
  kernel: MerchantHostKernel;
  events: AgentHostEvent[];
  subscribers: Set<ServerResponse>;
  createdAt: string;
  lastAccessAt: number;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, {
    ok: false,
    error: { code: "internal_error", message: "internal server error" },
  });
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "body_too_large", "request body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_json", "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid_path", "path contains invalid encoding");
  }
}

function positiveSequence(value: string | null): number {
  if (value === null || value.trim() === "") return 0;
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new HttpError(400, "invalid_sequence", "after must be a non-negative integer");
  }
  return sequence;
}

function pendingSummary(kernel: MerchantHostKernel): Array<Record<string, unknown>> {
  return kernel.listPendingApprovals().map((candidate) => ({
    candidate_id: candidate.candidate_id,
    tool: candidate.tool,
    risk: candidate.risk,
    status: candidate.status,
    expires_at: candidate.expires_at,
    stale_sensitive: true,
  }));
}

function sseEvent(event: AgentHostEvent): string {
  return [
    "id: " + String(event.sequence),
    "event: " + event.type,
    "data: " + JSON.stringify(event),
    "",
    "",
  ].join("\n");
}

function sseControlEvent(type: string, data: unknown): string {
  return ["event: " + type, "data: " + JSON.stringify(data), "", ""].join("\n");
}

function writeSse(response: ServerResponse, event: string): void {
  if (!response.destroyed) response.write(event);
}

function defaultFactory(options: MerchantHttpAdapterOptions): MerchantKernelFactory {
  return {
    async create(input) {
      return buildChatKernel(
        options.profile,
        input.dataDir,
        options.catalog,
        input.eventSink,
        input.eventSessionId,
        options.analyticsSource,
      );
    },
  };
}

export function createMerchantHttpServer(options: MerchantHttpAdapterOptions): Server {
  if (options.profile.role !== "merchant") {
    throw new Error("Merchant HTTP adapter requires a merchant profile");
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxEventBuffer = Math.max(1, Math.min(options.maxEventBuffer ?? DEFAULT_EVENT_BUFFER, 10_000));
  const maxSessions = Math.max(1, Math.min(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 10_000));
  const sessionIdleTtlMs = Math.max(1_000, options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS);
  const nowMs = options.nowMs ?? Date.now;
  const factory = options.kernelFactory ?? defaultFactory(options);
  const sessions = new Map<string, SessionRecord>();
  let pendingSessions = 0;

  const authorize = async (request: IncomingMessage): Promise<MerchantHostIdentity> => {
    try {
      const identity = await options.authenticate(request);
      if (
        identity === null ||
        typeof identity !== "object" ||
        typeof identity.principal_id !== "string" ||
        typeof identity.merchant_id !== "string" ||
        identity.principal_id === "" ||
        identity.merchant_id === ""
      ) {
        throw new Error("invalid identity");
      }
      if (identity.merchant_id !== options.profile.owner_id) {
        throw new HttpError(403, "merchant_forbidden", "authenticated merchant is not this profile owner");
      }
      return identity;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(401, "unauthorized", "merchant authentication failed");
    }
  };

  const closeSession = async (session: SessionRecord): Promise<void> => {
    sessions.delete(session.sessionId);
    for (const subscriber of session.subscribers) subscriber.end();
    session.subscribers.clear();
    await session.kernel.close().catch(() => undefined);
  };

  const sweepIdleSessions = async (): Promise<void> => {
    const cutoff = nowMs() - sessionIdleTtlMs;
    const expired = [...sessions.values()].filter(
      (session) => session.subscribers.size === 0 && session.lastAccessAt <= cutoff,
    );
    await Promise.allSettled(expired.map(closeSession));
  };

  const getSession = (sessionId: string, identity: MerchantHostIdentity): SessionRecord => {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new HttpError(404, "session_not_found", "merchant session not found");
    if (
      session.identity.principal_id !== identity.principal_id ||
      session.identity.merchant_id !== identity.merchant_id
    ) {
      throw new HttpError(403, "session_forbidden", "session does not belong to the authenticated principal");
    }
    session.lastAccessAt = nowMs();
    return session;
  };

  const createSession = async (identity: MerchantHostIdentity): Promise<SessionRecord> => {
    if (sessions.size + pendingSessions >= maxSessions) {
      throw new HttpError(429, "session_limit_reached", "merchant session limit reached");
    }
    pendingSessions += 1;
    try {
    const sessionId = randomUUID();
    const events: AgentHostEvent[] = [];
    let record: SessionRecord | undefined;
    const eventSink: AgentEventSink = {
      emit(event) {
        const stored: AgentHostEvent = {
          ...event,
          sessionId,
        };
        events.push(stored);
        while (events.length > maxEventBuffer) events.shift();
        if (record === undefined) return;
        for (const subscriber of record.subscribers) writeSse(subscriber, sseEvent(stored));
      },
    };
    const dataDir = path.join(options.dataRoot, sessionId);
    const kernel = await factory.create({ dataDir, eventSink, eventSessionId: sessionId });
    if (kernel.profile.role !== "merchant" || kernel.profile.owner_id !== options.profile.owner_id) {
      await kernel.close().catch(() => undefined);
      throw new HttpError(500, "kernel_identity_mismatch", "kernel does not match merchant profile");
    }
    record = {
      sessionId,
      identity,
      kernel,
      events,
      subscribers: new Set(),
      createdAt: new Date().toISOString(),
      lastAccessAt: nowMs(),
    };
    sessions.set(sessionId, record);
    return record;
    } finally {
      pendingSessions -= 1;
    }
  };

  const handleEvents = (request: IncomingMessage, response: ServerResponse, session: SessionRecord): void => {
    const url = new URL(request.url ?? "/", "http://" + (request.headers.host ?? "localhost"));
    const queryAfter = url.searchParams.get("after");
    const headerAfter = request.headers["last-event-id"];
    const after = positiveSequence(queryAfter ?? (typeof headerAfter === "string" ? headerAfter : null));
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const oldest = session.events[0]?.sequence;
    if (oldest !== undefined && after > 0 && after < oldest - 1) {
      writeSse(response, sseControlEvent("replay_gap", { after, oldest }));
    }
    for (const event of session.events) {
      if (event.sequence > after) writeSse(response, sseEvent(event));
    }
    session.subscribers.add(response);
    const heartbeat = setInterval(() => writeSse(response, ": keep-alive\n\n"), 15_000);
    heartbeat.unref();
    response.on("close", () => {
      clearInterval(heartbeat);
      session.subscribers.delete(response);
    });
  };

  const server = createServer(async (request, response) => {
    try {
      await sweepIdleSessions();
      const url = new URL(request.url ?? "/", "http://" + (request.headers.host ?? "localhost"));
      const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "kiwi-merchant-http", sessions: sessions.size });
        return;
      }

      if (segments.length === 3 && method === "POST" && segments[0] === "v1" && segments[1] === "merchant" && segments[2] === "sessions") {
        const identity = await authorize(request);
        const session = await createSession(identity);
        sendJson(response, 201, {
          ok: true,
          session_id: session.sessionId,
          created_at: session.createdAt,
          events_url: "/v1/merchant/sessions/" + session.sessionId + "/events",
        });
        return;
      }

      if (
        segments.length < 4 ||
        segments[0] !== "v1" ||
        segments[1] !== "merchant" ||
        segments[2] !== "sessions"
      ) {
        throw new HttpError(404, "not_found", method + " " + url.pathname);
      }

      const identity = await authorize(request);
      const session = getSession(segments[3] as string, identity);
      const sessionId = segments[3] as string;

      if (segments.length === 5 && method === "GET" && segments[4] === "events") {
        handleEvents(request, response, session);
        return;
      }

      if (segments.length === 4 && method === "GET") {
        sendJson(response, 200, {
          ok: true,
          session_id: sessionId,
          created_at: session.createdAt,
          pending_actions: pendingSummary(session.kernel),
        });
        return;
      }

      if (segments.length === 5 && method === "POST" && segments[4] === "messages") {
        const body = await readJson(request, maxBodyBytes);
        const message = body.message;
        if (typeof message !== "string" || message.trim() === "") {
          throw new HttpError(400, "invalid_message", "message must be a non-empty string");
        }
        if (message.length > MAX_MESSAGE_CHARS) {
          throw new HttpError(413, "message_too_large", "message exceeds the maximum length");
        }
        const reply = await session.kernel.handleUserText(message);
        sendJson(response, 200, {
          ok: true,
          session_id: sessionId,
          reply: reply.text,
          quit: reply.quit,
          pending_actions: pendingSummary(session.kernel),
        });
        return;
      }

      if (segments.length === 6 && method === "POST" && segments[4] === "approvals") {
        const candidateId = segments[5] as string;
        const body = await readJson(request, maxBodyBytes);
        const action = body.action;
        if (action === "approve") {
          const result = await session.kernel.approveCandidate(candidateId);
          sendJson(response, 200, { ok: true, session_id: sessionId, candidate_id: candidateId, result });
          return;
        }
        if (action === "reject") {
          const result = session.kernel.rejectCandidate(candidateId);
          sendJson(response, result.ok ? 200 : 409, {
            ok: result.ok,
            session_id: sessionId,
            candidate_id: candidateId,
            ...(result.error === undefined ? {} : { error: { code: "reject_failed", message: result.error } }),
          });
          return;
        }
        throw new HttpError(400, "invalid_approval_action", "action must be approve or reject");
      }

      if (segments.length === 4 && method === "DELETE") {
        await closeSession(session);
        sendJson(response, 200, { ok: true, session_id: sessionId });
        return;
      }

      throw new HttpError(404, "not_found", method + " " + url.pathname);
    } catch (error) {
      sendError(response, error);
    }
  });

  server.on("close", () => {
    void Promise.allSettled([...sessions.values()].map(closeSession));
  });

  return server;
}

export type { Server };
