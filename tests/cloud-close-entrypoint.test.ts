import { describe, expect, it, afterEach } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCloudShutdown, createOwnedCloudLifetime, isNodeBelowSupportLine, type OwnedCloudDeadlineEndContext } from "../src/cloud/main.js";
import { renderStartupFailure, CloudStartupError } from "../src/cloud/bootstrap.js";

const dirs: string[] = [];
afterEach(() => { for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "kiwi-main-close-")); dirs.push(root);
  mkdirSync(path.join(root, "cloud")); mkdirSync(path.join(root, "lifecycle"));
  copyFileSync(path.resolve("dist/cloud/main.js"), path.join(root, "cloud/main.js"));
  copyFileSync(path.resolve("dist/lifecycle/close.js"), path.join(root, "lifecycle/close.js"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  return root;
}
function run(root: string, source: string) {
  const entry = path.join(root, "runner.mjs"); writeFileSync(entry, source);
  return spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 3_000, maxBuffer: 16_384 });
}

describe("Cloud Node floor before bootstrap evaluation", () => {
  it.each(["20.19.0", "22.18.9", "v22.13.1", "garbage", "22.19"])("rejects %s", (version) => {
    expect(isNodeBelowSupportLine(version)).toBe(true);
  });
  it.each(["22.19.0", "v22.22.3", "24.0.0"])("accepts supported %s", (version) => {
    expect(isNodeBelowSupportLine(version)).toBe(false);
  });
  it.each(["22.18.9", "22.19.0"])("runs the real compiled main import order for %s", (version) => {
    const root = fixture(), marker = path.join(root, "bootstrap-loaded");
    writeFileSync(path.join(root, "cloud/bootstrap.js"), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'loaded');throw Error('SECRET fixture-import');`);
    const result = run(root, `Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});const {runCloudMain}=await import('./cloud/main.js');process.exit(await runCloudMain());`);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stderr).not.toContain("SECRET");
    expect(existsSync(marker)).toBe(version === "22.19.0");
    expect(result.stderr).toContain(version === "22.19.0" ? "BOOTSTRAP_LOAD_FAILED" : "NODE_UNSUPPORTED");
  });
  it("does not reflect unknown error text or a classified error message", () => {
    expect(renderStartupFailure(new Error("SECRET credential=fixture-only"))).not.toContain("SECRET");
    const text = renderStartupFailure(new CloudStartupError("PROFILE_LOAD_FAILED", "SECRET fixture-profile"));
    expect(text).toContain("PROFILE_LOAD_FAILED"); expect(text).not.toContain("SECRET");
  });
});

describe("Cloud shutdown completion and exit status", () => {
  it("shares concurrent shutdown and exits nonzero after a failure with fixed text", async () => {
    const exits: number[] = [], messages: string[] = []; let calls = 0;
    const close = createCloudShutdown(async () => { calls++; throw new Error("SECRET shutdown fixture"); }, (code) => { exits.push(code); }, (text) => { messages.push(text); });
    const first = close(); expect(close()).toBe(first); await first; await close();
    expect(calls).toBe(1); expect(exits).toEqual([1]); expect(messages.join("")).toContain("RESOURCE_CLOSE_FAILED"); expect(messages.join("")).not.toContain("SECRET");
  });
  it("still exits nonzero when the failure log sink also throws", async () => {
    const exits: number[] = [];
    const close = createCloudShutdown(async () => { throw new Error("fixture close"); }, (code) => { exits.push(code); }, () => { throw new Error("fixture log"); });
    await close(); expect(exits).toEqual([1]);
  });
  it.each(["success", "failure", "timeout"])("real compiled shutdown exits truthfully for %s", (mode) => {
    const root = fixture(), marker = path.join(root, "closed");
    const body = mode === "success" ? `async()=>{fs.writeFileSync(${JSON.stringify(marker)},'closed')}`
      : mode === "failure" ? "async()=>{throw Error('SECRET shutdown fixture')}" : "()=>new Promise(()=>{})";
    const result = run(root, `import fs from 'node:fs';const {createCloudShutdown}=await import('./cloud/main.js');await createCloudShutdown(${body},undefined,undefined,15)();`);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(mode === "success" ? 0 : 1);
    expect(existsSync(marker)).toBe(mode === "success"); expect(result.stderr).not.toContain("SECRET");
    if (mode !== "success") expect(result.stderr).toContain("RESOURCE_CLOSE_FAILED");
  });
  it("ordinary SIGTERM and SIGINT share one successful cleanup before exit0", () => {
    const root = fixture(), marker = path.join(root, "calls");
    writeFileSync(path.join(root, "cloud/bootstrap.js"), `import fs from 'node:fs';export function renderStartupFailure(){return 'FIXED';}export async function bootstrapCloudRuntime(){return {close:async()=>{fs.appendFileSync(${JSON.stringify(marker)},'x');await new Promise(r=>setTimeout(r,25));}};}`);
    const result = run(root, "const {runCloudMain}=await import('./cloud/main.js');void runCloudMain();setTimeout(()=>process.kill(process.pid,'SIGTERM'),20);setTimeout(()=>process.kill(process.pid,'SIGINT'),25);");
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(readFileSync(marker, "utf8")).toBe("x");
  });
});

describe("owned cloud lifetime deadline and terminalization callback contract", () => {
  function harness(onDeadlineEnd?: (context: OwnedCloudDeadlineEndContext) => void | Promise<void>, deadlineEndTimeoutMs = 5_000) {
    let wallMs = 1_000, monotonicMs = 100, tick: (() => void) | undefined;
    const events: string[] = [], exits: number[] = [];
    const server: Pick<Server, "close" | "closeAllConnections"> = {
      close() { events.push("ingress-stopped"); return this as Server; },
      closeAllConnections: () => { events.push("connections-closed"); },
    };
    const instance = { server, close: async () => { events.push("instance-closed"); } };
    const lifetime = createOwnedCloudLifetime(instance, 2_000, {
      now: () => wallMs,
      monotonicNow: () => monotonicMs,
      setTimer: (callback) => { tick = callback; return 1; },
      clearTimer: () => { events.push("timer-cleared"); },
      onDeadlineEnd,
      deadlineEndTimeoutMs,
      exit: (code) => { exits.push(code); },
      write: (line) => { events.push(line); },
    });
    return {
      events, exits, instance, lifetime,
      setWall: (value: number) => { wallMs = value; },
      setMonotonic: (value: number) => { monotonicMs = value; },
      fire: () => { if (!tick) throw new Error("missing fake timer"); tick(); },
    };
  }

  it("reports wall deadline and awaits the durable consumer before closing the SDK", async () => {
    let context: OwnedCloudDeadlineEndContext | undefined;
    const h = harness(async (value) => { context = value; h.events.push("deadline-callback"); });
    h.setWall(2_000); h.setMonotonic(1_100); h.fire();
    await h.lifetime.shutdown();
    expect(context?.reason).toBe("WALL_DEADLINE");
    expect(context).toMatchObject({ deadlineMs: 2_000, initialWallMs: 1_000, initialMonotonicMs: 100, observedWallMs: 2_000, observedMonotonicMs: 1_100 });
    expect(h.events.indexOf("ingress-stopped")).toBeLessThan(h.events.indexOf("deadline-callback"));
    expect(h.events.indexOf("deadline-callback")).toBeLessThan(h.events.indexOf("connections-closed"));
    expect(h.events.indexOf("connections-closed")).toBeLessThan(h.events.indexOf("instance-closed"));
    expect(h.exits).toEqual([0]);
  });

  it("reports a monotonic-only budget expiry even while wall time is frozen", async () => {
    let reason: OwnedCloudDeadlineEndContext["reason"] | undefined;
    const h = harness((context) => { reason = context.reason; });
    h.setWall(1_000); h.setMonotonic(1_100); h.fire();
    await h.lifetime.shutdown();
    expect(reason).toBe("MONOTONIC_BUDGET_EXHAUSTED");
    expect(h.events).toContain("instance-closed");
  });

  it("rechecks both clocks when shutdown races ahead of its queued deadline timer", async () => {
    let reason: OwnedCloudDeadlineEndContext["reason"] | undefined;
    const h = harness((context) => { reason = context.reason; });
    h.setWall(1_000); h.setMonotonic(1_100);
    await h.lifetime.shutdown();
    expect(reason).toBe("MONOTONIC_BUDGET_EXHAUSTED");
    expect(h.exits).toEqual([0]);
  });

  it("reports clock regression to the consumer instead of silently performing ordinary shutdown", async () => {
    let reason: OwnedCloudDeadlineEndContext["reason"] | undefined;
    const h = harness((context) => { reason = context.reason; });
    h.setWall(999); h.setMonotonic(101); h.fire();
    await h.lifetime.shutdown();
    expect(reason).toBe("CLOCK_INVALID_OR_REGRESSED");
    expect(h.exits).toEqual([0]);
  });

  it.each(["wall", "monotonic"] as const)("closes through the deadline callback when initial %s sampling throws", async (failedClock) => {
    const events: string[] = [], exits: number[] = [];
    let context: OwnedCloudDeadlineEndContext | undefined;
    let timerScheduled = false;
    const server: Pick<Server, "close" | "closeAllConnections"> = {
      close() { events.push("ingress-stopped"); return this as Server; },
      closeAllConnections: () => { events.push("connections-closed"); },
    };
    const instance = { server, close: async () => { events.push("instance-closed"); } };
    const lifetime = createOwnedCloudLifetime(instance, 2_000, {
      now: () => { if (failedClock === "wall") throw new Error("SECRET wall sample"); return 1_000; },
      monotonicNow: () => { if (failedClock === "monotonic") throw new Error("SECRET monotonic sample"); return 100; },
      setTimer: () => { timerScheduled = true; return 1; },
      clearTimer: () => { events.push("timer-cleared"); },
      onDeadlineEnd: (value) => { context = value; events.push("deadline-callback"); },
      exit: (code) => { exits.push(code); },
      write: (line) => { events.push(line); },
    });

    expect(lifetime.isStopping()).toBe(true);
    await lifetime.shutdown();
    expect(context?.reason).toBe("CLOCK_INVALID_OR_REGRESSED");
    expect(context?.signal).toBeInstanceOf(AbortSignal);
    expect(timerScheduled).toBe(false);
    expect(events.indexOf("ingress-stopped")).toBeLessThan(events.indexOf("deadline-callback"));
    expect(events.indexOf("deadline-callback")).toBeLessThan(events.indexOf("connections-closed"));
    expect(events.indexOf("connections-closed")).toBeLessThan(events.indexOf("instance-closed"));
    expect(exits).toEqual([0]);
    expect(events.join(" ")).not.toContain("SECRET");
  });

  it.each(["wall", "monotonic"] as const)("compiled main handles initial %s sampling failure through owned shutdown", (failedClock) => {
    const root = fixture();
    const eventsPath = path.join(root, "events.json");
    const contextPath = path.join(root, "context.txt");
    const exitPath = path.join(root, "exit.txt");
    const source = `
      import fs from 'node:fs';
      const { createOwnedCloudLifetime } = await import('./cloud/main.js');
      const events = [];
      const instance = {
        server: {
          close() { events.push('ingress-stopped'); return this; },
          closeAllConnections() { events.push('connections-closed'); },
        },
        async close() { events.push('instance-closed'); fs.writeFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(events)); },
      };
      const failWall = ${JSON.stringify(failedClock === "wall")};
      const failMonotonic = ${JSON.stringify(failedClock === "monotonic")};
      const lifetime = createOwnedCloudLifetime(instance, 2000, {
        now() { if (failWall) throw new Error('SECRET wall'); return 1000; },
        monotonicNow() { if (failMonotonic) throw new Error('SECRET monotonic'); return 100; },
        onDeadlineEnd({ reason }) { events.push('callback:' + reason); fs.writeFileSync(${JSON.stringify(contextPath)}, reason); },
        exit(code) { fs.writeFileSync(${JSON.stringify(exitPath)}, String(code)); process.exit(code); },
        write() {},
      });
      if (!lifetime.isStopping()) process.exit(87);
    `;
    const result = run(root, source);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("SECRET");
    expect(readFileSync(contextPath, "utf8")).toBe("CLOCK_INVALID_OR_REGRESSED");
    expect(readFileSync(exitPath, "utf8")).toBe("0");
    expect(JSON.parse(readFileSync(eventsPath, "utf8"))).toEqual([
      "ingress-stopped", "callback:CLOCK_INVALID_OR_REGRESSED", "connections-closed", "instance-closed",
    ]);
  });

  it("keeps a normal pre-deadline shutdown resumable and does not invoke the deadline callback", async () => {
    let callbacks = 0;
    const h = harness(() => { callbacks++; });
    await h.lifetime.shutdown();
    expect(callbacks).toBe(0);
    expect(h.events).toContain("instance-closed");
    expect(h.exits).toEqual([0]);
  });

  it("still closes the SDK and exits nonzero when the terminal callback fails", async () => {
    const h = harness(async () => { throw new Error("SECRET terminal fixture"); });
    h.setWall(2_000); h.setMonotonic(1_100); h.fire();
    await h.lifetime.shutdown();
    expect(h.events).toContain("instance-closed");
    expect(h.exits).toEqual([1]);
    expect(h.events.join(" ")).toContain("OWNED_DEADLINE_END_FAILED");
    expect(h.events.join(" ")).not.toContain("SECRET");
  });

  it("aborts a deadline callback after the small bound, closes, and does not equate exit with terminal proof", async () => {
    let aborted = false;
    const h = harness(({ signal }) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    }), 10);
    h.setWall(2_000); h.setMonotonic(1_100); h.fire();
    await h.lifetime.shutdown();
    expect(aborted).toBe(true);
    expect(h.events).toContain("instance-closed");
    expect(h.exits).toEqual([1]);
  });

  it("shares one deadline terminalization and cleanup across concurrent shutdown calls", async () => {
    let callbacks = 0, release: (() => void) | undefined;
    const h = harness(() => { callbacks++; return new Promise<void>((resolve) => { release = resolve; }); });
    h.setWall(2_000); h.setMonotonic(1_100); h.fire();
    const first = h.lifetime.shutdown(), second = h.lifetime.shutdown();
    expect(second).toBe(first);
    release?.();
    await first;
    expect(callbacks).toBe(1);
    expect(h.events.filter((item) => item === "instance-closed")).toHaveLength(1);
  });
});
