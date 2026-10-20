import { describe, expect, it } from "vitest";
import { createOwnedClock, ownedHostBootId } from "../src/cloud/owned-clock.js";
import { createOwnedCloudHost } from "../src/cloud/main.js";

describe("owned stable clock identity", () => {
  it("uses the OS boot identity and a cross-process stable host key", () => {
    const clock = createOwnedClock();
    const sample = clock.read();
    expect(clock.identity.bootId).toMatch(/^[A-F0-9-]{36}$/i);
    expect(ownedHostBootId(clock.identity)).toContain(clock.identity.bootId);
    expect(sample.provider).toBe(clock.identity.provider);
    expect(sample.monotonicNs).toMatch(/^\d+$/);
  });

  it("fails closed when the OS boot identity cannot be read", () => {
    const readFile = (() => { throw new Error("missing"); }) as never;
    expect(() => createOwnedClock({ platform: "linux", readFile })).toThrow(/OWNED_CLOCK_BOOT_ID_UNKNOWN/);
  });
});

describe("trusted embedded owned host", () => {
  it("exposes only the no-argument in-process permanent stop", async () => {
    let calls = 0;
    const host = createOwnedCloudHost({
      value: {}, status: () => undefined as never, isClosing: () => false, forwardingEnabled: () => true,
      reserveBusiness: () => {}, reserveMcp: () => {}, reserveCore: () => {}, close: async () => ({ status: "CLOSED" }),
      stopPermanently: async () => { calls++; return { status: "TERMINAL_CONFIRMED", reason: "OWNER_STOPPED_PERMANENTLY", revision: 1, ledger_sha256: "a".repeat(64) }; },
    });
    await expect(host.stopPermanently()).resolves.toMatchObject({ status: "TERMINAL_CONFIRMED" });
    expect(calls).toBe(1);
    expect(Object.keys(host)).toEqual(["stopPermanently"]);
  });
});
