import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LedgerPayloadSegmentStore } from "../src/negotiation/ledger/index.js";

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
});
