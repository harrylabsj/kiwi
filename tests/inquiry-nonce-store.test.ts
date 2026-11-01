import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InquiryNonceStore } from "../src/a2a/inquiry-nonce-store.js";

describe("open inquiry replay protection", () => {
  it("shares replay state across instances and restarts, and fails closed when full", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-inquiry-nonce-"));
    let now = 1_000_000;
    const first = new InquiryNonceStore(dir, { now: () => now, maxEntries: 1 });
    const second = new InquiryNonceStore(dir, { now: () => now, maxEntries: 1 });
    try {
      expect(first.checkAndSet("session-a|private-test-nonce")).toBe(true);
      expect(second.checkAndSet("session-a|private-test-nonce")).toBe(false);
      expect(second.checkAndSet("session-b|other")).toBe(false);
      expect(statSync(path.join(dir, "open-inquiry-nonces.sqlite")).mode & 0o777).toBe(0o600);
      now += 30 * 60_000 + 1;
      expect(second.checkAndSet("session-b|other")).toBe(true);
      expect(second.checkAndSet("")).toBe(false);
    } finally { first.close(); second.close(); }
    const reopened = new InquiryNonceStore(dir, { now: () => now });
    try {
      expect(reopened.checkAndSet("session-b|other")).toBe(false);
    } finally { reopened.close(); }
    expect(readFileSync(path.join(dir, "open-inquiry-nonces.sqlite")).includes(Buffer.from("private-test-nonce"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
