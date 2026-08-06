/**
 * `kiwi up` / `kiwi status` / `kiwi down` — managed-local lifecycle.
 *
 * up starts the shopping-cli gateway, waits for /health, then starts the
 * enabled buyer/merchant foreground agents — each through the child-runner
 * with a random nonce. All spawns use argv arrays (never shell strings).
 * up validates config/profiles/env BEFORE leaving any background process
 * behind and rolls back only processes it created on partial failure. It is
 * idempotent when its own instance is already healthy.
 *
 * down signals only verified wrapper PIDs (instance id + uid + live argv
 * nonce + fingerprint), waits a bounded time, escalates to SIGKILL only for
 * its own surviving verified wrapper, and reports — never kills — anything
 * unverifiable. Both are idempotent; cleanup touches only this instance's
 * run/ files.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile, ProfileError } from "../config/profile.js";
import {
  exitPathFor,
  fingerprint,
  logPathFor,
  manifestPathFor,
  newNonce,
  pidAlive,
  readExitRecord,
  readManifest,
  verifyProcess,
  wrapperArgv,
  writeManifestAtomic,
  type ExitRecord,
  type ProcessManifest,
  type Verification,
} from "./manifest.js";
import {
  instancePaths,
  MANAGED_ROLES,
  parseStackConfig,
  resolveProfilePath,
  StackConfigError,
  type ManagedRole,
  type StackConfig,
} from "./stack-config.js";

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 250;
const AGENT_GRACE_MS = 750;
const SIGTERM_WAIT_MS = 5_000;
const SIGKILL_WAIT_MS = 2_000;
const WAIT_POLL_MS = 100;

export class SupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorError";
  }
}

function cliPath(): string {
  const sibling = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  if (existsSync(sibling)) return sibling;
  // Dev/test (running from src/): use the built CLI from dist/.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");
}

/** Resolve an agent profile with proven containment inside the instance. */
function safeProfilePath(ctx: InstanceContext, role: "merchant" | "buyer"): string {
  try {
    return resolveProfilePath(ctx.paths.root, ctx.config.agents[role].profile, "stack config");
  } catch (err) {
    if (err instanceof StackConfigError) throw new SupervisorError(err.message);
    throw err;
  }
}

export interface InstanceContext {
  paths: ReturnType<typeof instancePaths>;
  config: StackConfig;
}

export function loadInstance(dir: string): InstanceContext {
  const paths = instancePaths(dir);
  let raw: string;
  try {
    raw = readFileSync(paths.config, "utf-8");
  } catch {
    throw new SupervisorError(
      `no Kiwi instance at ${paths.root} (missing ${path.basename(paths.config)}); run kiwi init first`,
    );
  }
  try {
    return { paths, config: parseStackConfig(raw, paths.config) };
  } catch (err) {
    if (err instanceof StackConfigError) throw new SupervisorError(err.message);
    throw err;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Bounded wait for a file to appear. */
async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await sleep(25);
  }
  return existsSync(file);
}

const READY_WAIT_MS = 3_000;

/** Spawn one managed process through the child-runner and write its manifest. */
export async function spawnManaged(
  ctx: InstanceContext,
  role: ManagedRole,
  command: string[],
  env: Record<string, string>,
): Promise<ProcessManifest> {
  const nonce = newNonce();
  const manifestPath = manifestPathFor(ctx.paths.run, role);
  const logPath = logPathFor(ctx.paths.logs, role);
  const exitPath = exitPathFor(ctx.paths.run, role);
  rmSync(exitPath, { force: true });
  rmSync(`${manifestPath}.ready`, { force: true });
  const argv = wrapperArgv(nonce, manifestPath, logPath, exitPath, command);
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  child.unref();
  if (child.pid === undefined) {
    throw new SupervisorError(`failed to spawn ${role}`);
  }
  const manifest: ProcessManifest = {
    manifest_version: 1,
    instance_id: ctx.config.instance_id,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    nonce,
    role,
    pid: child.pid,
    command,
    wrapper_argv: argv,
    command_fingerprint: fingerprint(argv),
    started_at: new Date().toISOString(),
    log_path: logPath,
    exit_path: exitPath,
  };
  writeManifestAtomic(manifestPath, manifest);
  // The child-runner marks readiness only after its signal handlers are
  // registered; no signal sent after this point can be lost.
  const ready = await waitForFile(`${manifestPath}.ready`, READY_WAIT_MS);
  if (!ready) {
    const exit = readExitRecord(exitPath);
    throw new SupervisorError(
      `${role} child-runner did not become ready` +
        (exit ? ` (exit_code=${String(exit.exit_code)})` : ""),
    );
  }
  return manifest;
}

async function waitHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) return false;
    await sleep(HEALTH_POLL_MS);
  }
}

async function waitExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(WAIT_POLL_MS);
  }
  return !pidAlive(pid);
}

export interface RoleState {
  role: ManagedRole;
  enabled: boolean;
  verified: boolean;
  running: boolean;
  exited?: ExitRecord | undefined;
  detail: string;
}

function roleEnabled(config: StackConfig, role: ManagedRole): boolean {
  if (role === "gateway") return true;
  return config.agents[role].enabled;
}

function roleState(ctx: InstanceContext, role: ManagedRole): RoleState {
  const enabled = roleEnabled(ctx.config, role);
  const manifestPath = manifestPathFor(ctx.paths.run, role);
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    return { role, enabled, verified: false, running: false, detail: "not started" };
  }
  // The manifest's role must match the file it lives in; a mismatch means
  // the file cannot be trusted and the process is never signaled.
  if (manifest.role !== role) {
    return {
      role,
      enabled,
      verified: false,
      running: pidAlive(manifest.pid),
      detail: `manifest role mismatch: ${role}.json describes role "${manifest.role}"`,
    };
  }
  const verification: Verification = verifyProcess(manifest, ctx.config.instance_id);
  const exited = verification.running ? undefined : readExitRecord(manifest.exit_path);
  return {
    role,
    enabled,
    verified: verification.verified,
    running: verification.running,
    exited,
    detail: verification.detail,
  };
}

/** Remove this instance's stale (not-running) run/ state for a role. */
function cleanStaleRunState(ctx: InstanceContext, role: ManagedRole): void {
  rmSync(manifestPathFor(ctx.paths.run, role), { force: true });
  rmSync(`${manifestPathFor(ctx.paths.run, role)}.ready`, { force: true });
  rmSync(exitPathFor(ctx.paths.run, role), { force: true });
}

export interface UpResult {
  instance_id: string;
  started: ManagedRole[];
  already_running: ManagedRole[];
  disabled: ManagedRole[];
  base_url: string;
}

export interface UpOptions {
  /** Test hooks: shorten bounded waits. */
  healthTimeoutMs?: number;
  agentGraceMs?: number;
}

export async function runUp(dir: string, options?: UpOptions): Promise<UpResult> {
  const healthTimeoutMs = options?.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const agentGraceMs = options?.agentGraceMs ?? AGENT_GRACE_MS;
  const ctx = loadInstance(dir);
  if (ctx.config.mode !== "managed-local") {
    throw new SupervisorError(
      `mode ${ctx.config.mode} is not managed by kiwi 0.5.0: start the gateway yourself and use kiwi agent run / doctor`,
    );
  }

  // 1. Ownership/running state FIRST (safe, needs no secrets): an already
  // verified+running stack must be idempotent even from a fresh shell
  // without the agent tokens in its environment.
  const started: ManagedRole[] = [];
  const alreadyRunning: ManagedRole[] = [];
  const disabled: ManagedRole[] = [];
  const toStart: ManagedRole[] = [];
  for (const role of MANAGED_ROLES) {
    if (!roleEnabled(ctx.config, role)) {
      disabled.push(role);
      continue;
    }
    const state = roleState(ctx, role);
    if (state.running && state.verified) {
      alreadyRunning.push(role);
      continue;
    }
    if (state.running && !state.verified) {
      throw new SupervisorError(
        `${role}: pid in manifest is alive but failed ownership verification (${state.detail}); refusing to disturb it — inspect ${ctx.paths.run} manually`,
      );
    }
    cleanStaleRunState(ctx, role); // only this instance's run/ files
    toStart.push(role);
  }

  // 2. Validate profiles and required env vars — only for agent roles that
  // actually need to start, and still before any process is spawned.
  const agentsToStart = toStart.filter((role) => role !== "gateway");
  if (agentsToStart.length > 0) {
    const missing: string[] = [];
    for (const role of agentsToStart) {
      // Containment is proven against the instance root, not by substring.
      const profilePath = safeProfilePath(ctx, role);
      try {
        const profile = loadProfile(profilePath);
        if (process.env[profile.commerce.token_env] === undefined) {
          missing.push(`${profile.commerce.token_env} (${role} commerce token)`);
        }
        if (profile.model.provider !== "fake" && profile.model.api_key_env !== undefined) {
          if (process.env[profile.model.api_key_env] === undefined) {
            missing.push(`${profile.model.api_key_env} (${role} model API key)`);
          }
        }
      } catch (err) {
        if (err instanceof ProfileError) {
          throw new SupervisorError(`${role} profile invalid: ${err.message}`);
        }
        throw err;
      }
    }
    if (missing.length > 0) {
      throw new SupervisorError(
        `missing required environment variables: ${missing.join(", ")} (names only; values are never printed)`,
      );
    }
  }

  // 3. Gateway health is a precondition for starting agents — even when the
  // gateway wrapper is already verified+running. If it stays unhealthy,
  // fail clearly: no agents are started and the pre-existing gateway is
  // left untouched.
  const gatewayInToStart = toStart.includes("gateway");
  if (agentsToStart.length > 0 && !gatewayInToStart) {
    if (!(await waitHealth(ctx.config.gateway.base_url, healthTimeoutMs))) {
      throw new SupervisorError(
        `gateway is already running but not healthy at ${ctx.config.gateway.base_url}; refusing to start agents (the running gateway was left untouched)`,
      );
    }
  }

  // 4. Start gateway, wait for health, then agents. Roll back only what we
  // started on any partial failure.
  const gatewayEnv: Record<string, string> = {
    ...ctx.config.gateway.env,
    SHOPPING_DEPLOYMENT_PROFILE: process.env.SHOPPING_DEPLOYMENT_PROFILE ?? "local",
    SHOPPING_ADMIN_TOKEN: process.env.SHOPPING_ADMIN_TOKEN ?? randomBytes(24).toString("base64url"),
    SHOPPING_BUYER_BOOTSTRAP_TOKEN:
      process.env.SHOPPING_BUYER_BOOTSTRAP_TOKEN ?? randomBytes(24).toString("base64url"),
  };
  const rollback = async (): Promise<void> => {
    for (const role of [...started].reverse()) {
      const manifest = readManifest(manifestPathFor(ctx.paths.run, role));
      if (manifest) await stopVerified(ctx, manifest);
      cleanStaleRunState(ctx, role);
    }
  };
  try {
    for (const role of toStart) {
      if (role === "gateway") {
        await spawnManaged(ctx, role, ctx.config.gateway.command, gatewayEnv);
        started.push(role);
        if (!(await waitHealth(ctx.config.gateway.base_url, healthTimeoutMs))) {
          throw new SupervisorError(
            `gateway did not become healthy within ${healthTimeoutMs / 1000}s at ${ctx.config.gateway.base_url}`,
          );
        }
      } else {
        const profilePath = safeProfilePath(ctx, role);
        await spawnManaged(
          ctx,
          role,
          [process.execPath, cliPath(), "agent", "run", "--profile", profilePath],
          {},
        );
        started.push(role);
        await sleep(agentGraceMs);
        const state = roleState(ctx, role);
        if (!state.running || state.exited !== undefined) {
          throw new SupervisorError(
            `${role} agent exited during startup (see ${logPathFor(ctx.paths.logs, role)})`,
          );
        }
      }
    }
  } catch (err) {
    await rollback();
    throw err;
  }

  return {
    instance_id: ctx.config.instance_id,
    started,
    already_running: alreadyRunning,
    disabled,
    base_url: ctx.config.gateway.base_url,
  };
}

export type StopOutcome = "stopped" | "killed" | "not_running" | "unverified";

/** Stop one manifest-owned process after verification. Never touches anything unverifiable. */
export async function stopVerified(
  ctx: InstanceContext,
  manifest: ProcessManifest,
): Promise<StopOutcome> {
  const verification = verifyProcess(manifest, ctx.config.instance_id);
  if (!verification.running) return "not_running";
  if (!verification.verified) return "unverified";
  // Never signal a child-runner whose readiness cannot be proven (the ready
  // marker is written only after its signal handlers are installed). If the
  // marker never appears, do NOT signal: report instead of risking a kill
  // before the handlers exist.
  const readyPath = `${manifestPathFor(ctx.paths.run, manifest.role)}.ready`;
  if (!existsSync(readyPath) && !(await waitForFile(readyPath, READY_WAIT_MS))) {
    return "unverified";
  }
  process.kill(manifest.pid, "SIGTERM");
  if (await waitExit(manifest.pid, SIGTERM_WAIT_MS)) return "stopped";
  // Escalate only against our own still-verified wrapper.
  const again = verifyProcess(manifest, ctx.config.instance_id);
  if (!again.running) return "stopped";
  if (!again.verified) return "unverified";
  process.kill(manifest.pid, "SIGKILL");
  return (await waitExit(manifest.pid, SIGKILL_WAIT_MS)) ? "killed" : "unverified";
}

export interface DownResult {
  instance_id: string;
  results: { role: ManagedRole; outcome: StopOutcome | "not_started"; detail: string }[];
}

export async function runDown(dir: string): Promise<DownResult> {
  const ctx = loadInstance(dir);
  const results: DownResult["results"] = [];
  // Agents first, gateway last.
  for (const role of [...MANAGED_ROLES].reverse()) {
    const manifest = readManifest(manifestPathFor(ctx.paths.run, role));
    if (!manifest) {
      results.push({ role, outcome: "not_started", detail: "no manifest" });
      continue;
    }
    if (manifest.role !== role) {
      // Report, never signal: the file cannot be trusted for this role.
      results.push({
        role,
        outcome: "unverified",
        detail: `manifest role mismatch: ${role}.json describes role "${manifest.role}"`,
      });
      continue;
    }
    const verification = verifyProcess(manifest, ctx.config.instance_id);
    if (verification.running && !verification.verified) {
      // Report, never kill: this process cannot be proven to be ours.
      results.push({ role, outcome: "unverified", detail: verification.detail });
      continue;
    }
    const outcome = await stopVerified(ctx, manifest);
    if (outcome !== "unverified") {
      cleanStaleRunState(ctx, role);
    }
    results.push({ role, outcome, detail: verification.detail });
  }
  return { instance_id: ctx.config.instance_id, results };
}

export interface StatusResult {
  ok: boolean;
  instance_id: string;
  mode: StackConfig["mode"];
  base_url: string;
  gateway_health: { ok: boolean; version?: string } | undefined;
  processes: RoleState[];
}

export async function runStatus(dir: string): Promise<StatusResult> {
  const ctx = loadInstance(dir);
  let health: StatusResult["gateway_health"];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(`${ctx.config.gateway.base_url}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = (await res.json()) as { ok?: boolean; version?: string };
    health = { ok: res.ok && body.ok === true, ...(body.version ? { version: body.version } : {}) };
  } catch {
    health = undefined;
  }
  const processes = MANAGED_ROLES.map((role) => roleState(ctx, role));
  const ok =
    (health?.ok ?? false) && processes.every((p) => !p.enabled || (p.running && p.verified));
  return {
    ok,
    instance_id: ctx.config.instance_id,
    mode: ctx.config.mode,
    base_url: ctx.config.gateway.base_url,
    gateway_health: health,
    processes,
  };
}
