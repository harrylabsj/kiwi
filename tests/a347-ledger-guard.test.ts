import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { LedgerStore, ledgerFileName } from "../src/negotiation/ledger/store.js";
const neg = "neg_a347_guard";
const dirs: string[] = [];
const children: ChildProcess[] = [];
let bundle: string;
beforeAll(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "a347-bundle-"));
  dirs.push(d);
  bundle = pathToFileURL(path.join(d, "ledger.mjs")).href;
  await build({
    entryPoints: [process.env.A347_SOURCE ?? path.resolve("src/negotiation/ledger/store.ts")],
    outfile: path.join(d, "ledger.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
});
afterEach(async () => {
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  const raw = process.env.A347_RAW_DIR;
  if (raw) {
    fs.mkdirSync(raw, { recursive: true });
    for (const dir of dirs) {
      const e = path.join(dir, "events.jsonl");
      if (fs.existsSync(e)) fs.copyFileSync(e, path.join(raw, path.basename(dir) + ".jsonl"));
    }
  }
});
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a347-guard-"));
  dirs.push(dir);
  const ledger = path.join(dir, "ledger", ledgerFileName(neg));
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  return {
    dir,
    ledger,
    lock: ledger + ".lock",
    guard: ledger + ".lock.guard",
    events: path.join(dir, "events.jsonl"),
  };
}
function logs(s: ReturnType<typeof setup>): any[] {
  return fs.existsSync(s.events)
    ? fs
        .readFileSync(s.events, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x))
    : [];
}
async function until(s: ReturnType<typeof setup>, actor: string, event: string) {
  const end = Date.now() + 6000;
  for (;;) {
    const v = logs(s).find((x) => x.actor === actor && x.event === event);
    if (v) return v;
    if (Date.now() > end)
      throw Error("parent timeout " + actor + " " + event + " " + JSON.stringify(logs(s)));
    await new Promise((r) => setTimeout(r, 10));
  }
}
function start(s: ReturnType<typeof setup>, actor: string, mode = "normal", extra = {}) {
  const release = path.join(s.dir, "release-" + actor);
  const c = spawn(
    process.execPath,
    [
      "tests/fixtures/a347-ledger-child.mjs",
      JSON.stringify({ ...s, actor, mode, release, bundle, neg, ...extra }),
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(c);
  let stderr = "";
  c.stderr!.on("data", (x) => (stderr += x));
  return {
    c,
    release,
    done: new Promise<number | null>((resolve, reject) => {
      c.on("error", reject);
      c.on("exit", (code) => {
        if (stderr) process.stderr.write(stderr);
        resolve(code);
      });
    }),
  };
}
function release(c: ReturnType<typeof start>) {
  fs.writeFileSync(c.release, "go");
}
async function deadPid() {
  const c = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = c.pid!;
  await new Promise((r) => c.once("exit", r));
  return pid;
}
function stale(s: ReturnType<typeof setup>, owner: any) {
  fs.writeFileSync(s.lock, typeof owner === "string" ? owner : JSON.stringify(owner));
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(s.lock, old, old);
}
function count(s: ReturnType<typeof setup>) {
  return fs.existsSync(s.ledger) ? fs.readFileSync(s.ledger, "utf8").trim().split("\n").length : 0;
}
function verify(s: ReturnType<typeof setup>, n: number) {
  const store = new LedgerStore({ dir: s.dir });
  expect(store.events(neg)).toHaveLength(n);
  expect(store.verifyChain(neg).valid).toBe(true);
}
describe("A347 shared main-lock mutation guard (real child processes)", () => {
  it("reclaimer holds guard against ordinary acquirer, then both append once", async () => {
    const s = setup();
    stale(s, { pid: await deadPid(), token: "dead" });
    const r = start(s, "R", "reclaim-pause");
    await until(s, "R", "barrier");
    const a = start(s, "A", "fn-pause");
    // On the old implementation A can reclaim and enter fn while R is paused
    // before unlink; on the fixed implementation A must stop at the guard.
    const end = Date.now() + 5000;
    let observation: any;
    while (
      !(observation = logs(s).find(
        (x) => x.actor === "A" && (x.event === "guard-blocked" || x.event === "fn-enter"),
      ))
    ) {
      if (Date.now() > end) throw Error("A did not try acquire");
      await new Promise((r) => setTimeout(r, 10));
    }
    release(r);
    expect(await r.done).toBe(0);
    await until(s, "A", "barrier");
    release(a);
    expect(await a.done).toBe(0);
    let active = 0,
      peak = 0;
    for (const e of logs(s)) {
      if (e.event === "fn-enter") peak = Math.max(peak, ++active);
      if (e.event === "fn-exit") active--;
    }
    // Safety expectations are identical when run against the original source.
    expect(observation.event).toBe("guard-blocked");
    expect(peak).toBe(1);
    verify(s, 2);
    expect(
      logs(s)
        .filter((x) => x.event === "fn-enter")
        .every((x) => !x.guardPresent),
    ).toBe(true);
  });
  it("ordinary wx acquisition waits while a guarded reclaim has temporarily removed the main lock", async () => {
    const s = setup();
    stale(s, { pid: await deadPid(), token: "dead" });
    const r = start(s, "R", "reclaim-gap");
    await until(s, "R", "barrier");
    expect(fs.existsSync(s.lock)).toBe(false);
    expect(fs.existsSync(s.guard)).toBe(true);
    const a = start(s, "A");
    await until(s, "A", "guard-blocked");
    expect(fs.existsSync(s.lock)).toBe(false);
    expect(logs(s).some((x) => x.actor === "A" && x.event === "fn-enter")).toBe(false);
    release(r);
    expect(await r.done).toBe(0);
    expect(await a.done).toBe(0);
    verify(s, 2);
  });
  it("second reclaimer cannot replace a new main owner while its fn is paused", async () => {
    const s = setup();
    stale(s, { pid: await deadPid(), token: "dead" });
    const r = start(s, "R", "fn-pause");
    await until(s, "R", "barrier");
    expect(fs.existsSync(s.guard)).toBe(false);
    const owner = fs.readFileSync(s.lock, "utf8");
    const a = start(s, "A");
    await until(s, "A", "guard-acquired");
    await new Promise((r) => setTimeout(r, 70));
    expect(fs.readFileSync(s.lock, "utf8")).toBe(owner);
    expect(logs(s).some((x) => x.actor === "A" && x.event === "fn-enter")).toBe(false);
    release(r);
    expect(await r.done).toBe(0);
    expect(await a.done).toBe(0);
    verify(s, 2);
  });
  it("normal release guard blocks an ordinary acquirer before unlink", async () => {
    const s = setup();
    const r = start(s, "R", "release-pause");
    await until(s, "R", "barrier");
    expect(count(s)).toBe(1);
    expect(fs.existsSync(s.guard)).toBe(true);
    const a = start(s, "A");
    await until(s, "A", "guard-blocked");
    expect(logs(s).some((x) => x.actor === "A" && x.event === "fn-enter")).toBe(false);
    release(r);
    expect(await r.done).toBe(0);
    expect(await a.done).toBe(0);
    verify(s, 2);
    expect(fs.existsSync(s.lock)).toBe(false);
  });
  it("crashed guard owner is never reclaimed, even with dead PID and old mtime", async () => {
    const s = setup();
    const r = start(s, "R", "guard-crash");
    await until(s, "R", "barrier");
    r.c.kill("SIGKILL");
    await r.done;
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(s.guard, old, old);
    const a = start(s, "A", "normal", { timeout: 100 });
    expect(await a.done).toBe(2);
    expect((await until(s, "A", "result")).code).toBe("ledger_append_locked");
    expect(count(s)).toBe(0);
    expect(fs.existsSync(s.guard)).toBe(true);
  });
  it("malformed unknown guard is preserved with bounded zero-effect failure", async () => {
    const s = setup();
    fs.writeFileSync(s.guard, "{");
    const a = start(s, "A", "normal", { timeout: 80 });
    const t = Date.now();
    expect(await a.done).toBe(2);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(count(s)).toBe(0);
    expect(fs.readFileSync(s.guard, "utf8")).toBe("{");
  });
  it.each(["EPERM", "EINVAL"])(
    "only ESRCH can recover a main owner (%s stays unknown)",
    async (killError) => {
      const s = setup();
      stale(s, { pid: 1, token: "keep" });
      const old = fs.readFileSync(s.lock, "utf8");
      const a = start(s, "A", "normal", { timeout: 80, killError });
      expect(await a.done).toBe(2);
      expect(count(s)).toBe(0);
      expect(fs.readFileSync(s.lock, "utf8")).toBe(old);
      expect(fs.existsSync(s.guard)).toBe(false);
    },
  );
  it("legacy positive dead PID is recovered; malformed owner is retained", async () => {
    const s = setup();
    stale(s, String(await deadPid()));
    const a = start(s, "A");
    expect(await a.done).toBe(0);
    verify(s, 1);
    stale(s, "{");
    const b = start(s, "B", "normal", { timeout: 80 });
    expect(await b.done).toBe(2);
    expect(count(s)).toBe(1);
    expect(fs.readFileSync(s.lock, "utf8")).toBe("{");
  });
  it("different main owner token is preserved on normal release", async () => {
    const s = setup();
    const r = start(s, "R", "fn-pause");
    await until(s, "R", "barrier");
    fs.writeFileSync(s.lock, JSON.stringify({ pid: process.pid, token: "replacement" }));
    release(r);
    expect(await r.done).toBe(0);
    expect(JSON.parse(fs.readFileSync(s.lock, "utf8")).token).toBe("replacement");
    verify(s, 1);
  });
  it.each(["cleanup-success", "cleanup-error"])(
    "guard cleanup failure preserves actual fn result (%s)",
    async (mode) => {
      const s = setup();
      const r = start(s, "R", mode, { timeout: 80 });
      expect(await r.done).toBe(mode === "cleanup-success" ? 0 : 2);
      const result = await until(s, "R", "result");
      if (mode === "cleanup-error") expect(result.message).toBe("ORIGINAL_FN_FAULT");
      expect(count(s)).toBe(mode === "cleanup-success" ? 1 : 0);
      expect(fs.existsSync(s.lock)).toBe(true);
      expect(fs.existsSync(s.guard)).toBe(true);
      const a = start(s, "A", "normal", { timeout: 80 });
      expect(await a.done).toBe(2);
      expect(count(s)).toBe(mode === "cleanup-success" ? 1 : 0);
    },
  );
  it.each(["guard-write-fault", "main-write-fault"])(
    "metadata write fault is zero-effect and leaves unknown ownership blocked (%s)",
    async (mode) => {
      const s = setup();
      const a = start(s, "A", mode, { timeout: 80 });
      expect(await a.done).toBe(2);
      expect(count(s)).toBe(0);
      const b = start(s, "B", "normal", { timeout: 80 });
      expect(await b.done).toBe(2);
      expect(count(s)).toBe(0);
    },
  );
});
