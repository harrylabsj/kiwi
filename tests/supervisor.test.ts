/**
 * M4 supervisor tests: init safety, stack config, manifest/verification,
 * wrapper lifecycle, up/status/down idempotency and rollback, log redaction
 * and CLI argument validation. Deterministic: stub node processes, small
 * bounded waits, temp instance dirs only.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import {
  assertSafeInstanceDir,
  instancePaths,
  parseStackConfig,
  resolveProfilePath,
  StackConfigError,
  validateStackConfig,
  type StackConfig,
} from "../src/supervisor/stack-config.js";
import { runInit } from "../src/supervisor/init.js";
import {
  fingerprint,
  manifestPathFor,
  newNonce,
  pidAlive,
  readExitRecord,
  readManifest,
  verifyProcess,
  wrapperArgv,
  writeManifestAtomic,
  type ProcessManifest,
} from "../src/supervisor/manifest.js";
import {
  loadInstance,
  runDown,
  runStatus,
  runUp,
  spawnManaged,
  stopVerified,
  type InstanceContext,
} from "../src/supervisor/manage.js";
import { parseLogLines, redactLine, runLogs } from "../src/supervisor/logs.js";
import { main as cliMain } from "../src/cli.js";

let workDir: string;
const cleanupPids: number[] = [];

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "kiwi-sup-"));
});

afterEach(async () => {
  // SIGTERM first so wrappers forward to their children; SIGKILL is only
  // the last resort (it would orphan the child).
  for (const pid of cleanupPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && cleanupPids.some((pid) => pidAlive(pid))) {
    await new Promise((r) => setTimeout(r, 25));
  }
  for (const pid of cleanupPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.SHOPPING_AGENT_TOKEN;
  delete process.env.SHOPPING_BUYER_TOKEN;
});

function instanceDir(): string {
  return path.join(workDir, "inst");
}

async function initInstance(fake = true): Promise<string> {
  const dir = instanceDir();
  await runInit({ dir, shoppingCliSrc: "/nonexistent-src", ...(fake ? { fake: true } : {}) }).catch(
    () => runInit({ dir, ...(fake ? { fake: true } : {}) }),
  );
  return dir;
}

/** Rewrite the instance gateway to a stub node HTTP server; agents disabled. */
function stubGateway(dir: string, script: string): StackConfig {
  const paths = instancePaths(dir);
  const config = parseStackConfig(readFileSync(paths.config, "utf-8"), paths.config);
  const port = new URL(config.gateway.base_url).port;
  const stubPath = path.join(workDir, "stub-gateway.cjs");
  writeFileSync(stubPath, script);
  config.gateway.command = [process.execPath, stubPath];
  config.gateway.env = { STUB_PORT: port };
  config.agents.merchant.enabled = false;
  config.agents.buyer.enabled = false;
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

const STUB_HEALTH_SERVER = `
const http = require("http");
http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "stub" }));
  } else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  }
}).listen(Number(process.env.STUB_PORT), "127.0.0.1");
`;

const SLEEPER = `setInterval(() => {}, 1000);`;

const TRAP_TERM_42 = `
process.on("SIGTERM", () => process.exit(42));
console.log("child-ready");
setInterval(() => {}, 1000);
`;

function makeManifest(ctx: InstanceContext, pid: number, nonce: string): ProcessManifest {
  const command = [process.execPath, "-e", SLEEPER];
  const argv = wrapperArgv(
    nonce,
    manifestPathFor(ctx.paths.run, "gateway"),
    path.join(ctx.paths.logs, "gateway.log"),
    path.join(ctx.paths.run, "gateway.exit.json"),
    command,
  );
  return {
    manifest_version: 1,
    instance_id: ctx.config.instance_id,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    nonce,
    role: "gateway",
    pid,
    command,
    wrapper_argv: argv,
    command_fingerprint: fingerprint(argv),
    started_at: new Date().toISOString(),
    log_path: path.join(ctx.paths.logs, "gateway.log"),
    exit_path: path.join(ctx.paths.run, "gateway.exit.json"),
  };
}

describe("stack config validation", () => {
  it("accepts a config produced by init (roundtrip)", async () => {
    const dir = await initInstance();
    const paths = instancePaths(dir);
    const config = parseStackConfig(readFileSync(paths.config, "utf-8"), paths.config);
    expect(config.mode).toBe("managed-local");
    expect(config.gateway.command.length).toBeGreaterThan(0);
    expect(config.instance_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects unknown fields and bad values at every level", async () => {
    const dir = await initInstance();
    const good = parseStackConfig(readFileSync(instancePaths(dir).config, "utf-8"), "t");
    const variants: [string, unknown][] = [
      ["unknown top field", { ...good, extra: 1 }],
      ["bad mode", { ...good, mode: "managed-cloud" }],
      ["bad instance_id", { ...good, instance_id: "xyz" }],
      ["bad stack_version", { ...good, stack_version: 2 }],
      ["empty command", { ...good, gateway: { ...good.gateway, command: [] } }],
      ["shell-string command", { ...good, gateway: { ...good.gateway, command: "python -m x" } }],
      ["bad env", { ...good, gateway: { ...good.gateway, env: { A: 1 } } }],
      [
        "absolute profile",
        {
          ...good,
          agents: { ...good.agents, merchant: { enabled: true, profile: "/etc/passwd" } },
        },
      ],
      [
        "traversal profile",
        {
          ...good,
          agents: { ...good.agents, buyer: { enabled: true, profile: "../outside.yaml" } },
        },
      ],
      [
        "unknown agent field",
        { ...good, agents: { ...good.agents, buyer: { enabled: true, profile: "p", x: 1 } } },
      ],
    ];
    for (const [name, variant] of variants) {
      expect(() => validateStackConfig(variant, "t"), name).toThrow(StackConfigError);
    }
  });

  it("refuses unsafe instance directories", () => {
    expect(() => assertSafeInstanceDir("/")).toThrow(/unsafe/);
    expect(() => assertSafeInstanceDir(homedir())).toThrow(/unsafe/);
    expect(() => assertSafeInstanceDir("/tmp")).toThrow(/unsafe/);
    expect(() => assertSafeInstanceDir(path.dirname(homedir()))).toThrow(/unsafe/);
    expect(assertSafeInstanceDir(path.join(workDir, "inst"))).toBe(path.join(workDir, "inst"));
  });
});

describe("kiwi init", () => {
  it("creates a self-contained instance with strict permissions", async () => {
    const dir = await initInstance();
    const paths = instancePaths(dir);
    for (const p of [paths.config, paths.profiles, paths.data, paths.logs, paths.run]) {
      expect(existsSync(p), p).toBe(true);
    }
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(statSync(paths.run).mode & 0o777).toBe(0o700);
    expect(statSync(paths.data).mode & 0o777).toBe(0o700); // shopping SQLite lives here
    // Profiles name env vars; they never contain secret values.
    const merchant = readFileSync(path.join(paths.profiles, "merchant.yaml"), "utf-8");
    const buyer = readFileSync(path.join(paths.profiles, "buyer.yaml"), "utf-8");
    expect(merchant).toContain("token_env: SHOPPING_AGENT_TOKEN");
    expect(buyer).toContain("token_env: SHOPPING_BUYER_TOKEN");
    expect(merchant).toContain("provider: fake");
    for (const content of [merchant, buyer]) {
      expect(content).not.toMatch(/shopping_(merchant|buyer)_[A-Za-z0-9_-]{8,}/);
      expect(content).not.toContain("sk-");
    }
  });

  it("default (non-fake) profiles use a real model with api_key_env", async () => {
    const dir = await initInstance(false);
    const merchant = readFileSync(path.join(instancePaths(dir).profiles, "merchant.yaml"), "utf-8");
    expect(merchant).toContain("provider: openai");
    expect(merchant).toContain("api_key_env: MODEL_API_KEY");
    expect(merchant).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("fails closed on re-init and never overwrites user files", async () => {
    const dir = await initInstance();
    await expect(runInit({ dir, fake: true })).rejects.toThrow(/already contains Kiwi state/);
    // A pre-existing user file at a target path is never overwritten.
    const dir2 = path.join(workDir, "inst2");
    mkdirSync(path.join(dir2, "profiles"), { recursive: true });
    writeFileSync(path.join(dir2, "profiles", "merchant.yaml"), "user content");
    await expect(runInit({ dir: dir2, fake: true })).rejects.toThrow(/refusing to overwrite/);
    expect(readFileSync(path.join(dir2, "profiles", "merchant.yaml"), "utf-8")).toBe(
      "user content",
    );
  });

  it("fails clearly when shopping-cli source is unavailable", async () => {
    await expect(
      runInit({ dir: instanceDir(), shoppingCliSrc: "/definitely/not/here" }),
    ).rejects.toThrow(/shopping-cli source not found/);
  });
});

describe("manifest and ownership verification", () => {
  it("writes manifests atomically with mode 0600", async () => {
    const dir = await initInstance();
    const ctx = loadInstance(dir);
    const manifest = makeManifest(ctx, process.pid, newNonce());
    const manifestPath = manifestPathFor(ctx.paths.run, "gateway");
    writeManifestAtomic(manifestPath, manifest);
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(readManifest(manifestPath)).toEqual(manifest);
  });

  it("verification: wrong instance, foreign pid, dead pid", async () => {
    const dir = await initInstance();
    const ctx = loadInstance(dir);
    // Alive but not ours (this test process has no nonce in argv).
    const foreign = makeManifest(ctx, process.pid, newNonce());
    const v1 = verifyProcess(foreign, ctx.config.instance_id);
    expect(v1.running).toBe(true);
    expect(v1.verified).toBe(false);
    // Wrong instance id.
    const v2 = verifyProcess(foreign, "0".repeat(32));
    expect(v2.verified).toBe(false);
    // Dead pid: verified (manifest is ours) but not running.
    const dead = makeManifest(ctx, 999_983, newNonce());
    const v3 = verifyProcess(dead, ctx.config.instance_id);
    expect(v3.verified).toBe(true);
    expect(v3.running).toBe(false);
  });
});

describe("child-runner lifecycle", () => {
  it("spawns, verifies and stops a managed process; exit record written", async () => {
    const dir = await initInstance();
    const ctx = loadInstance(dir);
    const manifest = await spawnManaged(ctx, "gateway", [process.execPath, "-e", SLEEPER], {});
    expect(readManifest(manifestPathFor(ctx.paths.run, "gateway"))?.pid).toBe(manifest.pid);
    const v = verifyProcess(manifest, ctx.config.instance_id);
    expect(v).toMatchObject({ verified: true, running: true });
    const outcome = await stopVerified(ctx, manifest);
    expect(outcome).toBe("stopped");
    expect(pidAlive(manifest.pid)).toBe(false);
    const exit = readExitRecord(manifest.exit_path);
    expect(exit).toBeDefined();
    expect(exit?.signal).toBe("SIGTERM");
  });

  it("wrapper forwards SIGTERM to its exact child (exit code 42)", async () => {
    const dir = await initInstance();
    const ctx = loadInstance(dir);
    const manifest = await spawnManaged(ctx, "gateway", [process.execPath, "-e", TRAP_TERM_42], {});
    // Wait until the child has installed its trap (visible in its log).
    const deadline = Date.now() + 3_000;
    let childReady = false;
    while (Date.now() < deadline) {
      try {
        if (readFileSync(manifest.log_path, "utf-8").includes("child-ready")) {
          childReady = true;
          break;
        }
      } catch {
        // log not written yet
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(childReady).toBe(true);
    const outcome = await stopVerified(ctx, manifest);
    expect(outcome).toBe("stopped");
    const exit = readExitRecord(manifest.exit_path);
    expect(exit?.exit_code).toBe(42);
  });

  it("unverifiable processes are reported, never killed", async () => {
    const dir = await initInstance();
    const ctx = loadInstance(dir);
    const manifest = await spawnManaged(ctx, "gateway", [process.execPath, "-e", SLEEPER], {});
    cleanupPids.push(manifest.pid);
    // Tamper: someone rewrote the nonce in the manifest.
    writeManifestAtomic(manifestPathFor(ctx.paths.run, "gateway"), {
      ...manifest,
      nonce: "0".repeat(32),
    });
    const tampered = readManifest(manifestPathFor(ctx.paths.run, "gateway"));
    expect(tampered).toBeDefined();
    const outcome = await stopVerified(ctx, tampered as ProcessManifest);
    expect(outcome).toBe("unverified");
    expect(pidAlive(manifest.pid)).toBe(true); // provably untouched
  });
});

describe("up / status / down with stub gateway", () => {
  it("up starts the gateway, is idempotent; status ok; down stops it, idempotent", async () => {
    const dir = await initInstance();
    stubGateway(dir, STUB_HEALTH_SERVER);

    const up1 = await runUp(dir, { healthTimeoutMs: 5_000 });
    expect(up1.started).toEqual(["gateway"]);
    expect(up1.disabled).toEqual(["merchant", "buyer"]);

    const status1 = await runStatus(dir);
    expect(status1.ok).toBe(true);
    expect(status1.gateway_health).toMatchObject({ ok: true, version: "stub" });
    const gatewayState = status1.processes.find((p) => p.role === "gateway");
    expect(gatewayState).toMatchObject({ verified: true, running: true });

    const up2 = await runUp(dir, { healthTimeoutMs: 5_000 });
    expect(up2.started).toEqual([]);
    expect(up2.already_running).toEqual(["gateway"]);
    const pid1 = readManifest(manifestPathFor(instancePaths(dir).run, "gateway"))?.pid;

    const down1 = await runDown(dir);
    expect(down1.results.find((r) => r.role === "gateway")?.outcome).toBe("stopped");
    expect(pidAlive(pid1 as number)).toBe(false);

    const down2 = await runDown(dir);
    expect(down2.results.every((r) => r.outcome === "not_started")).toBe(true);

    const status2 = await runStatus(dir);
    expect(status2.ok).toBe(false);
  });

  it("validates env before leaving processes behind (missing token -> nothing started)", async () => {
    const dir = await initInstance();
    stubGateway(dir, STUB_HEALTH_SERVER);
    const paths = instancePaths(dir);
    const config = parseStackConfig(readFileSync(paths.config, "utf-8"), paths.config);
    config.agents.merchant.enabled = true; // requires SHOPPING_AGENT_TOKEN
    writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`);
    delete process.env.SHOPPING_AGENT_TOKEN;

    await expect(runUp(dir, { healthTimeoutMs: 1_000 })).rejects.toThrow(/SHOPPING_AGENT_TOKEN/);
    // Nothing was started: no manifests, no processes.
    for (const role of ["gateway", "merchant", "buyer"] as const) {
      expect(existsSync(manifestPathFor(paths.run, role))).toBe(false);
    }
  });

  it("rolls back only its own processes on gateway startup failure", async () => {
    const dir = await initInstance();
    stubGateway(dir, "process.exit(1);");
    await expect(runUp(dir, { healthTimeoutMs: 1_500 })).rejects.toThrow(/did not become healthy/);
    const paths = instancePaths(dir);
    expect(existsSync(manifestPathFor(paths.run, "gateway"))).toBe(false);
    // No live process carries this instance's state.
    const status = await runStatus(dir);
    expect(status.processes.every((p) => !p.running)).toBe(true);
  });

  it("a separately started sentinel process survives down", async () => {
    const dir = await initInstance();
    stubGateway(dir, STUB_HEALTH_SERVER);
    await runUp(dir, { healthTimeoutMs: 5_000 });
    const sentinel = spawn(process.execPath, ["-e", SLEEPER], { detached: true, stdio: "ignore" });
    sentinel.unref();
    cleanupPids.push(sentinel.pid as number);

    await runDown(dir);
    expect(pidAlive(sentinel.pid as number)).toBe(true);
    const status = await runStatus(dir);
    expect(status.processes.every((p) => !p.running)).toBe(true);
  });
});

describe("logs", () => {
  it("redacts bearer tokens, api keys and private-policy numeric lines", async () => {
    const dir = await initInstance();
    const paths = instancePaths(dir);
    writeFileSync(
      path.join(paths.logs, "gateway.log"),
      [
        "info: Authorization: Bearer abcdef1234567890",
        "token=shopping_merchant_zzzSECRETzzz",
        "key sk-1234567890abcdef",
        "min_unit_price_private: 80.00",
        "最高预算是 200",
        "ordinary line with price 99 元",
        "",
      ].join("\n"),
    );
    const result = runLogs(dir, 100);
    const text = result.lines.join("\n");
    expect(text).not.toContain("abcdef1234567890");
    expect(text).not.toContain("zzzSECRETzzz");
    expect(text).not.toContain("sk-1234567890abcdef");
    expect(text).not.toContain("80.00");
    expect(text).not.toContain("200");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("ordinary line with price 99 元"); // public prices stay
    expect(result.lines.every((l) => l.startsWith("[gateway] "))).toBe(true);
  });

  it("redactLine covers common secret shapes", () => {
    expect(redactLine("Bearer abc")).not.toContain("abc");
    expect(redactLine("shopping_buyer_tokenvalue123")).toContain("[REDACTED]");
    expect(redactLine("api_key=supersecret")).not.toContain("supersecret");
    expect(redactLine("我的内部预算 150")).not.toContain("150");
    expect(redactLine("nothing secret here")).toBe("nothing secret here");
    // Regression: a lowercase shopping_* name used to consume the keyword
    // and leak the value; env[VAR]=value lines were missed entirely.
    expect(redactLine("shopping_agent_token=supersecret123")).not.toContain("supersecret123");
    expect(redactLine("env[SHOPPING_AGENT_TOKEN]=leaked")).not.toContain("leaked");
    expect(redactLine("SHOPPING_AGENT_TOKEN=value")).not.toContain("value");
    expect(redactLine("tokenize: true")).toBe("tokenize: true");
  });

  it("bounded tail and --lines validation", async () => {
    const dir = await initInstance();
    const paths = instancePaths(dir);
    writeFileSync(
      path.join(paths.logs, "merchant.log"),
      Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    expect(runLogs(dir, 10).lines).toHaveLength(10);
    expect(runLogs(dir, 10).lines[9]).toBe("[merchant] line 300");
    expect(parseLogLines(undefined)).toBe(100);
    expect(parseLogLines("1")).toBe(1);
    expect(parseLogLines("10000")).toBe(10_000);
    for (const bad of ["0", "-1", "abc", "10001", "1.5"]) {
      expect(() => parseLogLines(bad), bad).toThrow(/--lines/);
    }
  });

  it("refuses log paths outside the instance logs dir (path containment)", async () => {
    const dir = await initInstance();
    const ctx = loadInstance(dir);
    const manifest = makeManifest(ctx, process.pid, newNonce());
    manifest.log_path = "/etc/passwd";
    writeManifestAtomic(manifestPathFor(ctx.paths.run, "gateway"), manifest);
    const result = runLogs(dir, 100);
    expect(result.missing).toContain("gateway");
    expect(result.lines.join("\n")).not.toContain("root:");
  });
});

describe("CLI argument validation", () => {
  it("rejects unknown arguments and missing --dir", async () => {
    expect(await cliMain(["--bogus"])).toBe(2);
    expect(await cliMain(["init"])).toBe(2);
    expect(await cliMain(["up"])).toBe(2);
    expect(await cliMain(["status"])).toBe(2);
    expect(await cliMain(["down"])).toBe(2);
  });

  it("rejects invalid --lines", async () => {
    expect(await cliMain(["logs", "--dir", instanceDir(), "--lines", "0"])).toBe(2);
    expect(await cliMain(["logs", "--dir", instanceDir(), "--lines", "abc"])).toBe(2);
  });

  it("status on a missing instance fails clearly", async () => {
    expect(await cliMain(["status", "--dir", path.join(workDir, "nope")])).toBe(10);
  });

  it("agent run --once installs SIGINT/SIGTERM handlers and removes them after", async () => {
    const dir = await initInstance();
    const profilePath = path.join(instancePaths(dir).profiles, "merchant.yaml");
    process.env.SHOPPING_AGENT_TOKEN = "test-token";
    const registered: string[] = [];
    const originalOnce = process.once.bind(process);
    process.once = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      registered.push(String(event));
      return originalOnce(event, listener);
    }) as typeof process.once;
    const baseSigint = process.listenerCount("SIGINT");
    const baseSigterm = process.listenerCount("SIGTERM");
    let code = -1;
    try {
      code = await cliMain(["agent", "run", "--once", "--profile", profilePath]);
    } finally {
      process.once = originalOnce;
    }
    // No gateway is running: the turn fails transient (10), but the signal
    // handlers were installed for the attempt and are gone afterwards.
    expect(code).toBe(10);
    expect(registered).toContain("SIGINT");
    expect(registered).toContain("SIGTERM");
    expect(process.listenerCount("SIGINT")).toBe(baseSigint);
    expect(process.listenerCount("SIGTERM")).toBe(baseSigterm);
  });
});

describe("readiness gate: no signal when readiness cannot be proven", () => {
  it("stopVerified and runDown never signal without the ready marker", async () => {
    const dir = await initInstance();
    const ctx = loadInstance(dir);
    const manifest = await spawnManaged(ctx, "gateway", [process.execPath, "-e", SLEEPER], {});
    cleanupPids.push(manifest.pid);
    // Readiness can no longer be proven (marker removed after spawn).
    rmSync(`${manifestPathFor(ctx.paths.run, "gateway")}.ready`, { force: true });

    const outcome = await stopVerified(ctx, manifest);
    expect(outcome).toBe("unverified");
    expect(pidAlive(manifest.pid)).toBe(true); // provably untouched

    const down = await runDown(dir);
    expect(down.results.find((r) => r.role === "gateway")?.outcome).toBe("unverified");
    expect(pidAlive(manifest.pid)).toBe(true); // still untouched
  });
});

describe("gateway health precondition", () => {
  const STUB_DIE_SERVER = `
const http = require("http");
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "stub" }));
  } else if (req.url === "/die") {
    res.writeHead(200);
    res.end("bye");
    server.close();
    server.closeAllConnections();
  } else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  }
});
server.listen(Number(process.env.STUB_PORT), "127.0.0.1");
setInterval(() => {}, 1000);
`;

  it("already-running but unhealthy gateway: agents are not started, gateway untouched", async () => {
    const dir = await initInstance();
    stubGateway(dir, STUB_DIE_SERVER);
    await runUp(dir, { healthTimeoutMs: 5_000 });
    const gatewayPid = readManifest(manifestPathFor(instancePaths(dir).run, "gateway"))
      ?.pid as number;
    cleanupPids.push(gatewayPid);

    // Kill the HTTP listener but keep the wrapper alive and verified.
    const port = new URL((await runStatus(dir)).base_url).port;
    await fetch(`http://127.0.0.1:${port}/die`);
    await new Promise((r) => setTimeout(r, 200));

    // Enable the merchant agent; provide its env so validation passes.
    const paths = instancePaths(dir);
    const config = parseStackConfig(readFileSync(paths.config, "utf-8"), paths.config);
    config.agents.merchant.enabled = true;
    writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`);
    process.env.SHOPPING_AGENT_TOKEN = "dummy-token";

    await expect(runUp(dir, { healthTimeoutMs: 1_000 })).rejects.toThrow(/not healthy/);
    // No agent was started; the pre-existing gateway was not killed.
    expect(existsSync(manifestPathFor(paths.run, "merchant"))).toBe(false);
    expect(pidAlive(gatewayPid)).toBe(true);
  });
});

describe("idempotent up without agent env (fresh shell)", () => {
  it("returns already_running with unchanged pids when the whole stack is verified", async () => {
    const dir = await initInstance();
    stubGateway(dir, STUB_HEALTH_SERVER);
    const ctx = loadInstance(dir);
    // Gateway only via up; agents are "started" as managed sleepers with env present.
    process.env.SHOPPING_AGENT_TOKEN = "dummy-merchant-token";
    process.env.SHOPPING_BUYER_TOKEN = "dummy-buyer-token";
    await runUp(dir, { healthTimeoutMs: 5_000 });
    const paths = instancePaths(dir);
    const config = parseStackConfig(readFileSync(paths.config, "utf-8"), paths.config);
    config.agents.merchant.enabled = true;
    config.agents.buyer.enabled = true;
    writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`);
    const merchantManifest = await spawnManaged(
      ctx,
      "merchant",
      [process.execPath, "-e", SLEEPER],
      {},
    );
    const buyerManifest = await spawnManaged(ctx, "buyer", [process.execPath, "-e", SLEEPER], {});
    cleanupPids.push(merchantManifest.pid, buyerManifest.pid);
    const pidsBefore = {
      gateway: readManifest(manifestPathFor(paths.run, "gateway"))?.pid,
      merchant: merchantManifest.pid,
      buyer: buyerManifest.pid,
    };

    // Fresh shell: no agent tokens in the environment.
    delete process.env.SHOPPING_AGENT_TOKEN;
    delete process.env.SHOPPING_BUYER_TOKEN;
    const up2 = await runUp(dir, { healthTimeoutMs: 5_000 });
    expect(up2.started).toEqual([]);
    expect(up2.already_running).toEqual(["gateway", "merchant", "buyer"]);
    expect(readManifest(manifestPathFor(paths.run, "gateway"))?.pid).toBe(pidsBefore.gateway);
    expect(readManifest(manifestPathFor(paths.run, "merchant"))?.pid).toBe(pidsBefore.merchant);
    expect(readManifest(manifestPathFor(paths.run, "buyer"))?.pid).toBe(pidsBefore.buyer);

    // First-start validation is NOT weakened: with an agent actually needing
    // a start, missing env still fails before anything spawns.
    await runDown(dir);
    await expect(runUp(dir, { healthTimeoutMs: 1_000 })).rejects.toThrow(/SHOPPING_AGENT_TOKEN/);
  });
});

describe("init is transactional", () => {
  it("a profile conflict leaves user files and zero Kiwi artifacts behind", async () => {
    const dir = path.join(workDir, "inst-conflict");
    mkdirSync(path.join(dir, "profiles"), { recursive: true });
    writeFileSync(path.join(dir, "profiles", "merchant.yaml"), "user content");
    await expect(runInit({ dir, fake: true })).rejects.toThrow(/refusing to overwrite/);
    expect(readFileSync(path.join(dir, "profiles", "merchant.yaml"), "utf-8")).toBe("user content");
    const paths = instancePaths(dir);
    expect(existsSync(paths.config)).toBe(false);
    expect(existsSync(paths.run)).toBe(false);
    expect(existsSync(paths.data)).toBe(false);
    expect(existsSync(paths.logs)).toBe(false);
    // The pre-existing user dir itself is untouched; a retry stays safe.
    expect(existsSync(paths.profiles)).toBe(true);
    await expect(runInit({ dir, fake: true })).rejects.toThrow(/refusing to overwrite/);
  });
});

describe("manifest hardening and role binding", () => {
  it("readManifest rejects malformed/tampered fields", async () => {
    const dir = await initInstance();
    const ctx = loadInstance(dir);
    const good = makeManifest(ctx, 1234, newNonce());
    const manifestPath = manifestPathFor(ctx.paths.run, "gateway");
    const variants: [string, unknown][] = [
      ["pid zero", { ...good, pid: 0 }],
      ["pid fractional", { ...good, pid: 12.5 }],
      ["uid negative", { ...good, uid: -1 }],
      ["nonce short", { ...good, nonce: "abcd" }],
      ["nonce non-hex", { ...good, nonce: "z".repeat(32) }],
      ["role unknown", { ...good, role: "admin" }],
      ["command empty", { ...good, command: [] }],
      ["wrapper_argv empty", { ...good, wrapper_argv: [] }],
      ["log path missing", { ...good, log_path: 42 }],
      ["fingerprint empty", { ...good, command_fingerprint: "" }],
    ];
    for (const [name, variant] of variants) {
      writeFileSync(manifestPath, JSON.stringify(variant), { mode: 0o600 });
      expect(readManifest(manifestPath), name).toBeUndefined();
    }
  });

  it("role/file mismatch is unverified and never signaled; sentinel survives", async () => {
    const dir = await initInstance();
    const ctx = loadInstance(dir);
    const manifest = await spawnManaged(ctx, "gateway", [process.execPath, "-e", SLEEPER], {});
    cleanupPids.push(manifest.pid);
    const sentinel = spawn(process.execPath, ["-e", SLEEPER], { detached: true, stdio: "ignore" });
    sentinel.unref();
    cleanupPids.push(sentinel.pid as number);

    // Tamper: gateway.json now claims role "merchant".
    writeManifestAtomic(manifestPathFor(ctx.paths.run, "gateway"), {
      ...manifest,
      role: "merchant",
    });

    const down = await runDown(dir);
    expect(down.results.find((r) => r.role === "gateway")?.outcome).toBe("unverified");
    expect(pidAlive(manifest.pid)).toBe(true);
    expect(pidAlive(sentinel.pid as number)).toBe(true);

    const status = await runStatus(dir);
    const gateway = status.processes.find((p) => p.role === "gateway");
    expect(gateway?.verified).toBe(false);
    expect(gateway?.detail).toMatch(/role mismatch/);
  });
});

describe("stack config URL and profile containment", () => {
  it("validates gateway.base_url structurally per mode", async () => {
    const dir = await initInstance();
    const good = parseStackConfig(readFileSync(instancePaths(dir).config, "utf-8"), "t");
    const withUrl = (url: string, mode: "managed-local" | "connected" = "managed-local") => ({
      ...good,
      mode,
      gateway: { ...good.gateway, base_url: url },
    });
    const badManaged: [string, string][] = [
      ["credentials", "http://user:pass@127.0.0.1:8765"],
      ["fragment", "http://127.0.0.1:8765/#frag"],
      ["query", "http://127.0.0.1:8765/?x=1"],
      ["https managed-local", "https://127.0.0.1:8765"],
      ["non-loopback http", "http://example.com:8765"],
      ["non-loopback ip", "http://192.168.1.10:8765"],
      ["missing port", "http://127.0.0.1"],
      ["port zero", "http://127.0.0.1:0"],
      ["port too large", "http://127.0.0.1:70000"],
      ["non-http scheme", "ftp://127.0.0.1:8765"],
    ];
    for (const [name, url] of badManaged) {
      expect(() => validateStackConfig(withUrl(url), "t"), name).toThrow(StackConfigError);
    }
    // Valid managed-local loopback variants.
    for (const url of ["http://127.0.0.1:8765", "http://localhost:8765", "http://[::1]:8765"]) {
      expect(validateStackConfig(withUrl(url), "t").gateway.base_url, url).toBe(url);
    }
    // connected: HTTPS anywhere is fine; non-loopback HTTP is not.
    expect(
      validateStackConfig(withUrl("https://commerce.example.com", "connected"), "t").mode,
    ).toBe("connected");
    expect(() =>
      validateStackConfig(withUrl("http://commerce.example.com", "connected"), "t"),
    ).toThrow(/cleartext HTTP/);
  });

  it("profile paths: containment proven, traversal rejected, two-dot filenames allowed", async () => {
    const dir = await initInstance();
    const good = parseStackConfig(readFileSync(instancePaths(dir).config, "utf-8"), "t");
    const withProfile = (profile: string) => ({
      ...good,
      agents: { ...good.agents, merchant: { enabled: true, profile } },
    });
    // Harmless two-dot filename passes validation and resolves inside root.
    const ok = validateStackConfig(withProfile("profiles/merchant.v1..yaml"), "t");
    expect(ok.agents.merchant.profile).toBe("profiles/merchant.v1..yaml");
    const resolved = resolveProfilePath(dir, "profiles/merchant.v1..yaml", "t");
    expect(resolved.startsWith(path.resolve(dir) + path.sep)).toBe(true);
    // Traversal and absolute paths rejected at both levels.
    for (const bad of ["../outside.yaml", "profiles/../../etc/passwd", "/etc/passwd"]) {
      expect(() => validateStackConfig(withProfile(bad), "t"), bad).toThrow(StackConfigError);
      expect(() => resolveProfilePath(dir, bad, "t"), bad).toThrow(StackConfigError);
    }
  });
});
