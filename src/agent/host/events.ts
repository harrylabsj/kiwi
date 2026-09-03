/**
 * Optional host-facing event protocol for Merchant Experience integrations.
 *
 * Events are projections for TUI/Web/Buddy hosts. They are not a second
 * business state store: protocol, approval, task and ledger stores remain the
 * sources of truth.
 */

import { sanitizeModelValue } from "../context/fencing.js";

export type AgentHostEventType =
  | "message"
  | "text_delta"
  | "tool_call"
  | "tool_result"
  | "grounding_started"
  | "grounding_completed"
  | "ui"
  | "ui_partial"
  | "candidate_update"
  | "negotiation_update"
  | "progress"
  | "turn_complete"
  | "error";

export interface AgentHostEvent<T = unknown> {
  eventId: string;
  sessionId: string;
  sequence: number;
  type: AgentHostEventType;
  occurredAt: string;
  data: T;
}

export interface AgentEventSink {
  emit(event: AgentHostEvent): void | Promise<void>;
}

export const NOOP_EVENT_SINK: AgentEventSink = { emit: () => undefined };

const SENSITIVE_EVENT_KEY = /authorization|bearer|token|secret|password|credential|private_key|vault/i;
const MAX_REDACTION_DEPTH = 20;

function redactSensitiveKeys(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) return "[nested value omitted]";
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveKeys(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_EVENT_KEY.test(key) ? "[redacted]" : redactSensitiveKeys(entry, depth + 1),
      ]),
    );
  }
  return value;
}

/** Tool inputs are operator-visible projections, never raw request/log payloads. */
export function sanitizeHostEventData(type: AgentHostEventType, data: unknown): unknown {
  if (type !== "tool_call" && type !== "tool_result" && type !== "ui_partial" && type !== "text_delta") return data;
  try {
    return sanitizeModelValue(redactSensitiveKeys(data), { maxChars: 4_000 });
  } catch {
    return { note: "payload omitted" };
  }
}

/** Preserve emit order even when the underlying sink performs asynchronous I/O. */
export class SerializedEventSink implements AgentEventSink {
  private readonly target: AgentEventSink;
  private chain: Promise<void> = Promise.resolve();

  constructor(target: AgentEventSink) {
    this.target = target;
  }

  emit(event: AgentHostEvent): Promise<void> {
    this.chain = this.chain.then(async () => {
      await this.target.emit(event);
    }).catch(() => undefined);
    return this.chain;
  }
}

/** Best-effort event emission; host transport failure must not fail a business action. */
export async function emitHostEvent(
  sink: AgentEventSink | undefined,
  event: AgentHostEvent,
): Promise<void> {
  if (sink === undefined) return;
  try {
    await sink.emit(event);
  } catch {
    // Event delivery is an optional projection. The caller owns logging if it
    // needs telemetry, while the business state remains authoritative.
  }
}
