import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LedgerPayloadSegmentStore } from "../src/negotiation/ledger/index.js";
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
