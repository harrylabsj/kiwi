import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LedgerPayloadRedactedError, LedgerPayloadSegmentStore } from "../src/negotiation/ledger/index.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";

describe("Ledger payload segments", () => {
  it("stores canonical content by digest and rejects tampering/path escape", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-segments-"));
    try {
      const store = new LedgerPayloadSegmentStore({ dir: root, now: () => "2026-09-22T12:00:00.000Z" });
      const first = store.put({ z: 1, a: ["正文"] });
      const second = store.put({ a: ["正文"], z: 1 });
      expect(second.digest).toBe(first.digest);
      expect(store.get(first)).toEqual({ a: ["正文"], z: 1 });
      expect(store.remove(first)).toBe(true);
      expect(store.remove(first)).toBe(false);
      expect(() => store.get({ ...first, path: "../escape.json" })).toThrow(/path/);
    } finally {
      expect(existsSync(root)).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps forbidden private payload keys out of segment storage", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-segments-secret-"));
    try {
      const store = new LedgerPayloadSegmentStore({ dir: root });
      expect(() => store.put({ password: "must-not-persist" })).toThrow(/MUST NOT record/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts segmented content with a durable opaque tombstone and blocks resurrection", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-redaction-"));
    try {
      const store = new LedgerPayloadSegmentStore({ dir: root, now: () => "2026-09-23T10:00:00.000Z" });
      const payload = { action: "message", body: "private buyer text" };
      const ref = store.put(payload);
      const receipt = store.redact(ref, { redactionId: "wpr_test-1" });

      expect(receipt).toMatchObject({ redactedAt: "2026-09-23T10:00:00.000Z", alreadyRedacted: false });
      expect(receipt.receiptId).toMatch(/^lpr_[A-Za-z0-9_-]+$/u);
      expect(existsSync(path.join(root, ref.path))).toBe(false);
      expect(readFileSync(path.join(root, ".redactions", ref.path), "utf8")).not.toContain("private buyer text");
      expect(() => store.get(ref)).toThrow(LedgerPayloadRedactedError);
      expect(() => store.put(payload)).toThrow(LedgerPayloadRedactedError);

      const replay = store.redact(ref, { redactionId: "wpr_test-1" });
      expect(replay).toEqual({ receiptId: receipt.receiptId, redactedAt: receipt.redactedAt, alreadyRedacted: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets LedgerStore append an event with raw payload externalized", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-segmented-event-"));
    try {
      const segments = new LedgerPayloadSegmentStore({ dir: path.join(root, "segments") });
      const ledger = new LedgerStore({ dir: root, payloadSegments: segments });
      const event = ledger.appendSegmented({
        event_kind: "message_sent",
        negotiation_id: "neg-segmented",
        identity: { sender_identity: "kiwi", counterparty_identity: "shop" },
        capability: { capability: "rfq", protocol_version: "KNP/1.0" },
        wire_digest: "sha256:wire",
        wire_payload: { action: "rfq", message_id: "m1" },
        outcome: { kind: "ok", result: { accepted: true } },
        occurred_at: "2026-09-22T12:00:00.000Z",
      });
      expect(event.wire_payload).toBeUndefined();
      expect(event.outcome).toEqual({ kind: "ok" });
      expect(event.payload_segments?.wire_payload).toBeDefined();
      expect(event.payload_segments?.outcome_result).toBeDefined();
      expect(ledger.resolvePayload(event).wire_payload).toEqual({ action: "rfq", message_id: "m1" });
      expect(ledger.resolvePayload(event).outcome).toEqual({ kind: "ok", result: { accepted: true } });
      expect(segments.get(event.payload_segments!.wire_payload!)).toEqual({ action: "rfq", message_id: "m1" });
      expect(segments.get(event.payload_segments!.outcome_result!)).toEqual({ accepted: true });
      expect(ledger.verifyChain("neg-segmented").valid).toBe(true);

      segments.redact(event.payload_segments!.wire_payload!, { redactionId: "wpr_ledger-1" });
      segments.redact(event.payload_segments!.outcome_result!, { redactionId: "wpr_ledger-1" });
      expect(ledger.verifyChain("neg-segmented").valid).toBe(true);
      expect(() => ledger.resolvePayload(event)).toThrow(LedgerPayloadRedactedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not erase a content-addressed payload shared by another verified identity", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-shared-redaction-"));
    try {
      const segments = new LedgerPayloadSegmentStore({ dir: path.join(root, "segments") });
      const ledger = new LedgerStore({ dir: root, payloadSegments: segments });
      const sharedPayload = { action: "rfq", body: "same content" };
      const target = ledger.appendSegmented({
        event_kind: "message_received",
        negotiation_id: "neg-target",
        identity: { sender_identity: "buyer-target", counterparty_identity: "merchant", actor: "buyer" },
        capability: { capability: "rfq", protocol_version: "KNP/1.0" },
        wire_payload: sharedPayload,
        outcome: { kind: "ok" },
        occurred_at: "2026-09-23T10:00:00.000Z",
      });
      const unrelated = ledger.appendSegmented({
        event_kind: "message_received",
        negotiation_id: "neg-unrelated",
        identity: { sender_identity: "buyer-other", counterparty_identity: "merchant", actor: "buyer" },
        capability: { capability: "rfq", protocol_version: "KNP/1.0" },
        wire_payload: sharedPayload,
        outcome: { kind: "ok" },
        occurred_at: "2026-09-23T10:01:00.000Z",
      });

      const report = ledger.redactPayloadsForIdentity({
        senderIdentity: "buyer-target",
        redactionId: "wpr-shared-content",
      });
      expect(report).toMatchObject({
        status: "restricted",
        matchedNegotiations: 1,
        matchedEvents: 1,
        redactedSegments: 0,
        sharedSegments: 1,
        inlinePayloadEvents: 0,
        limitations: ["identity_envelope_retained", "shared_segment_retained"],
      });
      expect(ledger.resolvePayload(target).wire_payload).toEqual(sharedPayload);
      expect(ledger.resolvePayload(unrelated).wire_payload).toEqual(sharedPayload);
      expect(ledger.verifyChain("neg-target").valid).toBe(true);
      expect(ledger.verifyChain("neg-unrelated").valid).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports inline payloads as restricted instead of rewriting append-only Ledger events", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-ledger-inline-redaction-"));
    try {
      const ledger = new LedgerStore({ dir: root });
      ledger.append({
        event_kind: "message_received",
        negotiation_id: "neg-inline",
        identity: { sender_identity: "buyer-inline", counterparty_identity: "merchant", actor: "buyer" },
        capability: { capability: "rfq", protocol_version: "KNP/1.0" },
        wire_payload: { action: "rfq", body: "legacy inline buyer text" },
        outcome: { kind: "ok" },
        occurred_at: "2026-09-23T10:00:00.000Z",
      });
      const report = ledger.redactPayloadsForIdentity({
        senderIdentity: "buyer-inline",
        redactionId: "wpr-inline-content",
      });
      expect(report).toMatchObject({
        status: "restricted",
        matchedEvents: 1,
        inlinePayloadEvents: 1,
        redactedSegments: 0,
        limitations: ["identity_envelope_retained", "inline_payload_retained"],
      });
      expect(ledger.events("neg-inline")[0]?.wire_payload).toMatchObject({
        body: "legacy inline buyer text",
      });
      expect(ledger.verifyChain("neg-inline").valid).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
