import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
let m: typeof import("../src/a2a/server/pipeline.js") &
  typeof import("../src/a2a/server/task-registry.js") &
  typeof import("../src/negotiation/ledger/store.js") &
  typeof import("../src/negotiation/idempotency/store.js");
const dirs: string[] = [];
function dir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "a360-clock-r1-"));
  dirs.push(d);
  return d;
}
beforeAll(async () => {
  const d = fs.mkdtempSync(path.join(process.cwd(), ".a360-clock-bundle-"));
  dirs.push(d);
  const base = process.env.A360_CLOCK_SOURCE ?? process.cwd();
  const entry = path.join(d, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      "a2a/server/pipeline",
      "a2a/server/task-registry",
      "negotiation/ledger/store",
      "negotiation/idempotency/store",
    ]
      .map((p) => `export * from ${JSON.stringify(path.join(base, "src", p + ".ts"))};`)
      .join("\n"),
  );
  await build({
    entryPoints: [entry],
    outfile: path.join(d, "bundle.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  m = await import(pathToFileURL(path.join(d, "bundle.mjs")).href);
});
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function pipe(d: string, idem: { coordinationScope(): string; sweep(nowIso?: string): number | void }, now: () => string) {
  return new m.InboundPipeline({
    idempotency: idem as import("../src/negotiation/idempotency/store.js").IdempotencyStore,
    ledger: new m.LedgerStore({ dir: d, now }),
    tasks: new m.TaskRegistry(),
    now,
    handler: {
      handle: () => {
        throw Error("unexpected handler");
      },
    } as unknown as import("../src/a2a/server/types.js").NegotiationHandler,
    logError: () => {},
  });
}
async function tick(p: import("../src/a2a/server/pipeline.js").InboundPipeline) {
  // Invalid input deliberately stops after lazy cleanup: no handler or commit
  // can mask whether the existing on-disk record was removed.
  await expect(p.sendMessage({ message: null }, { senderIdentity: "peer" })).rejects.toBeDefined();
}
function seed(d: string) {
  let storeTime = "2026-10-01T00:00:00.000Z";
  const idem = new m.IdempotencyStore({ dir: d, now: () => storeTime });
  idem.commit({
    sender_identity: "peer",
    message_id: "old",
    digest: "d",
    negotiation_id: "neg",
    outcome: { result: { id: "task" } } as unknown as Parameters<import("../src/negotiation/idempotency/store.js").IdempotencyStore["commit"]>[0]["outcome"],
    retention: {},
  });
  const file = path.join(
    d,
    "idempotency",
    fs.readdirSync(path.join(d, "idempotency")).find((x: string) => x.startsWith("idem-"))!,
  );
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  // Use the recorded retention boundary, not an assumption about its duration.
  const expiry = Date.parse(record.expires_at);
  return {
    idem,
    file,
    expiry,
    setStoreTime: (n: number) => {
      storeTime = new Date(n).toISOString();
    },
  };
}
describe("A360 3-14 R1 actual expiry and successful sweep timestamps", () => {
  it("pipeline cutoff preserves actual record even when store clock is after expiry", async () => {
    const d = dir(),
      s = seed(d);
    s.setStoreTime(s.expiry + 60_000);
    const before = fs.readFileSync(s.file, "utf8");
    await tick(pipe(d, s.idem, () => new Date(s.expiry - 60_000).toISOString()));
    expect(fs.existsSync(s.file)).toBe(true);
    expect(fs.readFileSync(s.file, "utf8")).toBe(before);
  });
  it("pipeline cutoff removes actual expired record even when store clock is before expiry, preserving unknown", async () => {
    const d = dir(),
      s = seed(d);
    s.setStoreTime(s.expiry - 60_000);
    s.idem.markInFlight({
      sender_identity: "peer",
      message_id: "unknown",
      digest: "unknown-d",
      negotiation_id: "neg",
    } as Parameters<import("../src/negotiation/idempotency/store.js").IdempotencyStore["markInFlight"]>[0]);
    const claim = s.idem.readInFlight("peer", "unknown");
    await tick(pipe(d, s.idem, () => new Date(s.expiry + 60_000).toISOString()));
    expect(fs.existsSync(s.file)).toBe(false);
    expect(s.idem.readInFlight("peer", "unknown")).toEqual(claim);
  });
  it("real filesystem sweep failure retries at the same captured time and removes expired record", async () => {
    const d = dir(),
      s = seed(d);
    s.setStoreTime(s.expiry + 60_000);
    const p = pipe(d, s.idem, () => new Date(s.expiry + 60_000).toISOString());
    const idx = path.join(d, "idempotency"),
      held = path.join(d, "held");
    fs.renameSync(idx, held);
    fs.writeFileSync(idx, "blocks mkdir");
    try {
      await tick(p);
      expect(fs.existsSync(path.join(held, path.basename(s.file)))).toBe(true);
    } finally {
      fs.unlinkSync(idx);
      fs.renameSync(held, idx);
    }
    await tick(p);
    expect(fs.existsSync(s.file)).toBe(false);
  });
  it("successful cleanup throttles real records until the pipeline interval elapses", async () => {
    const d = dir(),
      s = seed(d);
    let cutoff = s.expiry + 60_000;
    const p = pipe(d, s.idem, () => new Date(cutoff).toISOString());
    await tick(p);
    expect(fs.existsSync(s.file)).toBe(false);
    const next = seed(d);
    await tick(p);
    expect(fs.existsSync(next.file)).toBe(true);
    cutoff += 5 * 60_000;
    await tick(p);
    expect(fs.existsSync(next.file)).toBe(false);
  });
  it("4096-scope timestamp eviction only permits an extra sweep", async () => {
    const d = dir();
    let firstSweeps = 0;
    const now = () => "2026-10-08T00:00:00.000Z";
    const fake = (scope: string, cb: () => void) => ({ coordinationScope: () => scope, sweep: cb });
    const first = pipe(
      d,
      fake(`${d}:first`, () => firstSweeps++),
      now,
    );
    await tick(first);
    for (let n = 0; n < 4096; n++)
      await tick(
        pipe(
          d,
          fake(`${d}:${n}`, () => {}),
          now,
        ),
      );
    await tick(first);
    expect(firstSweeps).toBe(2);
  });
});
