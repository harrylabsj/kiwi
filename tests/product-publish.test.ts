import { describe, expect, it } from "vitest";
import { merchantPublish } from "../src/product-publish.js";
import { testProfile } from "./helpers.js";

describe("merchant publication requires a connected Runtime", () => {
  it("never falls back to an owner token when enrollment is missing", async () => {
    let networkCalls = 0;
    const report = await merchantPublish({
      profile: testProfile({ agent_id: "merchant-local", owner_id: "merchant-owner" }),
      catalogBaseUrl: "https://catalog.example",
      ownerToken: "legacy-secret-must-not-be-used",
      shoppingCliDb: "/tmp/shop.sqlite",
      fetchImpl: (async () => {
        networkCalls += 1;
        throw new Error("unexpected network request");
      }) as typeof fetch,
      spawnImpl: ((_cmd: string, args: string[]) => args.includes("--version")
        ? { status: 0, stdout: "shopping.py 2.0.0\n", stderr: "" }
        : { status: 0, stdout: JSON.stringify({ ok: true, results: [] }), stderr: "" }) as unknown as typeof import("node:child_process").spawnSync,
    });
    expect(report.ok).toBe(false);
    expect(report.steps.listings.authorization_mode).toBe("runtime_binding");
    expect(report.steps.listings.skipped_reason).toContain("kiwi merchant connect");
    expect(networkCalls).toBe(0);
  });
});
