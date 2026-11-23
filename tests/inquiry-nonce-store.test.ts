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
    const unavailable: string[] = [];
    const second = new InquiryNonceStore(dir, { now: () => now, maxEntries: 1, onUnavailable: (reason) => unavailable.push(reason) });
    try {
      expect(first.checkAndSet("session-a|private-test-nonce")).toBe(true);
      expect(second.checkAndSet("session-a|private-test-nonce")).toBe(false);
      expect(second.checkAndSet("session-b|other")).toBe(false);
      expect(unavailable).toContain("capacity");
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


it("keeps independent durable quotas and recognizes unexpired shared-table entries after upgrade", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-inquiry-nonce-scopes-"));
  let now = 1_000_000;
  const failures: string[] = [];
  const opts = { now: () => now, maxEntries: 1, onUnavailable: (reason: string, scope: string) => failures.push(`${scope}:${reason}`) };
  try {
    const legacy = new InquiryNonceStore(dir, opts);
    try {
      expect(legacy.checkAndSet("signed:legacy-request")).toBe(true);
    } finally { legacy.close(); }
    const current = new InquiryNonceStore(dir, opts);
    try {
      expect(current.record("signed:legacy-request", "signed")).toBe("duplicate");
      expect(current.record("open-1", "open_inquiry")).toBe("fresh");
      expect(current.record("open-2", "open_inquiry")).toBe("unavailable");
      expect(current.record("open-1", "open_inquiry")).toBe("duplicate");
      expect(current.record("signed:verified-1", "signed")).toBe("fresh");
      expect(current.record("signed:verified-2", "signed")).toBe("unavailable");
      expect(current.record("signed:verified-1", "signed")).toBe("duplicate");
      expect(failures).toEqual(["open_inquiry:capacity", "signed:capacity"]);
    } finally { current.close(); }
    expect(current.record("signed:verified-2", "signed")).toBe("unavailable");
    expect(failures.at(-1)).toBe("signed:storage");
    const reopened = new InquiryNonceStore(dir, opts);
    try {
      expect(reopened.record("signed:verified-1", "signed")).toBe("duplicate");
      expect(reopened.record("open-1", "open_inquiry")).toBe("duplicate");
      now += 30 * 60_000;
      expect(reopened.record("signed:legacy-request", "signed")).toBe("fresh");
      expect(reopened.record("open-2", "open_inquiry")).toBe("fresh");
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
