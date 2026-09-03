/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { sanitizeModelText } from "../context/fencing.js";
import { sanitizePresentationValue } from "../presentation/sanitize.js";
import type { AgentHostEvent } from "./events.js";

const MAX_ITEMS = 100;

export interface MerchantWebMessage {
  role: "user" | "assistant" | "system";
  text: string;
  sequence: number;
  occurredAt: string;
}

export interface MerchantWebToolState {
  tool: string;
  callId: string;
  status: "running" | "ok" | "error";
  input?: unknown;
  summary?: string;
  partial?: unknown;
}

export interface MerchantWebViewState {
  lastSequence: number;
  streamText: string;
  messages: MerchantWebMessage[];
  grounding: Record<string, { tool: string; status: string }>;
  tools: Record<string, MerchantWebToolState>;
  ui: Record<string, { payload: unknown; sequence: number }>;
  candidates: Record<string, { status: string; preview?: unknown }>;
  negotiations: Record<string, { phase: string; summary: string }>;
  progress: Array<{ message: string; operation?: string; step?: string }>;
  errors: Array<{ code: string; message: string; retryable?: boolean }>;
  replayGap?: { after: number; oldest: number };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maxChars = 2_000): string {
  return typeof value === "string" ? sanitizeModelText(value, { maxChars }) : "";
}

function id(value: unknown): string {
  return text(value, 200);
}

function boundedPush<T>(items: T[], item: T): void {
  items.push(item);
  while (items.length > MAX_ITEMS) items.shift();
}

function boundedSet<T>(items: Record<string, T>, key: string, value: T): void {
  items[key] = value;
  while (Object.keys(items).length > MAX_ITEMS) {
    const oldest = Object.keys(items)[0];
    if (oldest === undefined) break;
    delete items[oldest];
  }
}

function safePayload(value: unknown): unknown {
  return sanitizePresentationValue(value, { maxChars: 2_000, maxItems: MAX_ITEMS });
}

function emptyState(): MerchantWebViewState {
  return {
    lastSequence: 0,
    streamText: "",
    messages: [],
    grounding: {},
    tools: {},
    ui: {},
    candidates: {},
    negotiations: {},
    progress: [],
    errors: [],
  };
}

/**
 * Framework-neutral reducer for Web/Buddy hosts.
 *
 * It is intentionally a state reducer rather than a DOM/React renderer. The
 * transport may replay events, so duplicate or older sequence numbers are
 * ignored. All values are copied and sanitized before entering view state.
 */
export class MerchantWebEventRenderer {
  private state: MerchantWebViewState = emptyState();

  get snapshot(): MerchantWebViewState {
    return structuredClone(this.state);
  }

  reset(): void {
    this.state = emptyState();
  }

  applyReplayGap(after: number, oldest: number): void {
    if (!Number.isSafeInteger(after) || !Number.isSafeInteger(oldest) || after < 0 || oldest < 0) return;
    this.state.replayGap = { after, oldest };
  }

  apply(event: AgentHostEvent): MerchantWebViewState {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= this.state.lastSequence) {
      return this.snapshot;
    }
    this.state.lastSequence = event.sequence;
    const data = record(event.data);
    switch (event.type) {
      case "message": {
        const role = data.role === "user" || data.role === "system" ? data.role : "assistant";
        boundedPush(this.state.messages, {
          role,
          text: text(data.text),
          sequence: event.sequence,
          occurredAt: text(event.occurredAt, 64),
        });
        if (role === "assistant") this.state.streamText = "";
        break;
      }
      case "text_delta":
        this.state.streamText = `${this.state.streamText}${text(data.text, 4_000)}`.slice(-20_000);
        break;
      case "grounding_started":
        boundedSet(this.state.grounding, id(data.rule) || id(data.tool), { tool: id(data.tool), status: "running" });
        break;
      case "grounding_completed":
        boundedSet(this.state.grounding, id(data.rule) || id(data.tool), { tool: id(data.tool), status: id(data.status) });
        break;
      case "tool_call": {
        const callId = id(data.call_id);
        if (callId !== "") {
          boundedSet(this.state.tools, callId, {
            tool: id(data.tool),
            callId,
            status: "running",
            input: safePayload(data.input),
          });
        }
        break;
      }
      case "ui_partial": {
        const callId = id(data.call_id);
        if (callId !== "") {
          const current = this.state.tools[callId];
          boundedSet(this.state.tools, callId, {
            tool: id(data.tool) || current?.tool || "",
            callId,
            status: current?.status ?? "running",
            ...(current?.input === undefined ? {} : { input: current.input }),
            partial: safePayload(data.partial),
          });
        }
        break;
      }
      case "tool_result": {
        const callId = id(data.call_id);
        if (callId !== "") {
          const current = this.state.tools[callId];
          boundedSet(this.state.tools, callId, {
            tool: id(data.tool) || current?.tool || "",
            callId,
            status: data.status === "error" ? "error" : "ok",
            ...(current?.input === undefined ? {} : { input: current.input }),
            summary: text(data.summary, 4_000),
            ...(current?.partial === undefined ? {} : { partial: current.partial }),
          });
        }
        break;
      }
      case "ui": {
        const component = id(data.component);
        if (component !== "") boundedSet(this.state.ui, component, { payload: safePayload(data.payload), sequence: event.sequence });
        break;
      }
      case "candidate_update": {
        const candidateId = id(data.candidate_id);
        if (candidateId !== "") boundedSet(this.state.candidates, candidateId, {
          status: id(data.status),
          ...(data.preview === undefined ? {} : { preview: safePayload(data.preview) }),
        });
        break;
      }
      case "negotiation_update": {
        const negotiationId = id(data.negotiation_id);
        if (negotiationId !== "") boundedSet(this.state.negotiations, negotiationId, {
          phase: id(data.phase),
          summary: text(data.summary),
        });
        break;
      }
      case "progress":
        boundedPush(this.state.progress, {
          message: text(data.message),
          ...(data.operation === undefined ? {} : { operation: id(data.operation) }),
          ...(data.step === undefined ? {} : { step: id(data.step) }),
        });
        break;
      case "error":
        boundedPush(this.state.errors, {
          code: id(data.code),
          message: text(data.message),
          ...(typeof data.retryable === "boolean" ? { retryable: data.retryable } : {}),
        });
        break;
      default:
        break;
    }
    return this.snapshot;
  }
}
