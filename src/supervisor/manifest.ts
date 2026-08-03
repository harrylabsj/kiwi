/**
 * Process manifest and ownership verification (M4).
 *
 * Every managed process is started through the internal child-runner
 * (supervisor/wrapper.ts) with a cryptographically random per-process nonce
 * visible in the wrapper argv. The manifest (mode 0600, atomically renamed
 * into the private run/ dir) binds: instance id, uid, nonce, exact role,
 * wrapper pid, command fingerprint and start metadata.
 *
 * status/down NEVER use pgrep, fuzzy name matching, or kill-by-port. A
 * process is only signaled after: instance id + uid match, the pid is
 * alive, and the live process argv contains the exact nonce and wrapper
 * path — which makes PID-reuse kills cryptographically improbable.
 */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedRole } from "./stack-config.js";

export interface ProcessManifest {
  manifest_version: 1;
  instance_id: string;
  uid: number;
  nonce: string;
  role: ManagedRole;
  /** PID of the wrapper (the only PID ever signaled). */
  pid: number;
  /** Exact child command argv (never a shell string). */
  command: string[];
  /** Full wrapper argv as spawned (includes the nonce). */
  wrapper_argv: string[];
  /** sha256 of JSON.stringify(wrapper_argv). */
  command_fingerprint: string;
  started_at: string;
  log_path: string;
  exit_path: string;
}

export interface Verification {
  verified: boolean;
  running: boolean;
  detail: string;
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function wrapperPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.join(here, "wrapper.js");
  if (existsSync(sibling)) return sibling;
  // Dev/test (running from src/): use the built wrapper from dist/.
  return path.resolve(here, "..", "..", "dist", "supervisor", "wrapper.js");
}

/** Full wrapper argv: the nonce is always visible to ps for verification. */
export function wrapperArgv(
  nonce: string,
  manifestPath: string,
  logPath: string,
  exitPath: string,
  command: string[],
): string[] {
  return [
    wrapperPath(),
    "--kiwi-nonce",
    nonce,
    "--manifest",
    manifestPath,
    "--log",
    logPath,
    "--exit",
    exitPath,
    "--",
    ...command,
  ];
}

export function fingerprint(argv: string[]): string {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

export function manifestPathFor(runDir: string, role: ManagedRole): string {
  return path.join(runDir, `${role}.json`);
}

export function exitPathFor(runDir: string, role: ManagedRole): string {
  return path.join(runDir, `${role}.exit.json`);
}

export function logPathFor(logsDir: string, role: ManagedRole): string {
  return path.join(logsDir, `${role}.log`);
}

/** Atomic mode-0600 write: temp file in the same dir, fsync, rename. */
export function writeManifestAtomic(manifestPath: string, manifest: ProcessManifest): void {
  const tmp = `${manifestPath}.tmp-${process.pid}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, manifestPath);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && v.length > 0)
  );
}

/**
 * Parse a manifest file, fail closed: any malformed or tampered field makes
 * the whole manifest unreadable, and an unreadable manifest is never
 * signaled.
 */
export function readManifest(manifestPath: string): ProcessManifest | undefined {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const data = JSON.parse(raw) as ProcessManifest;
    if (
      data.manifest_version !== 1 ||
      typeof data.instance_id !== "string" ||
      !/^[0-9a-f]{32}$/.test(data.instance_id) ||
      typeof data.uid !== "number" ||
      !Number.isSafeInteger(data.uid) ||
      data.uid < 0 ||
      typeof data.nonce !== "string" ||
      !/^[0-9a-f]{32}$/.test(data.nonce) ||
      (data.role !== "gateway" && data.role !== "merchant" && data.role !== "buyer") ||
      typeof data.pid !== "number" ||
      !Number.isSafeInteger(data.pid) ||
      data.pid <= 0 ||
      !isNonEmptyStringArray(data.command) ||
      !isNonEmptyStringArray(data.wrapper_argv) ||
      typeof data.command_fingerprint !== "string" ||
      data.command_fingerprint.length === 0 ||
      typeof data.started_at !== "string" ||
      typeof data.log_path !== "string" ||
      typeof data.exit_path !== "string"
    ) {
      return undefined;
    }
    return data;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else: alive,
    // and the uid check in verifyProcess will refuse to touch it.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** argv of a live pid via ps for the exact PID (never pgrep/name matching). */
function psArgs(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

export interface ExitRecord {
  exit_code: number | null;
  signal: string | null;
  at: string;
}

export function readExitRecord(exitPath: string): ExitRecord | undefined {
  try {
    const data = JSON.parse(readFileSync(exitPath, "utf-8")) as ExitRecord;
    if (typeof data.at !== "string") return undefined;
    return data;
  } catch {
    return undefined;
  }
}

/**
 * Verify that the live process at manifest.pid is exactly the wrapper this
 * instance started: same instance, same uid, alive, argv carries the exact
 * nonce and wrapper path, and the stored fingerprint matches the recomputed
 * wrapper argv.
 */
export function verifyProcess(manifest: ProcessManifest, expectedInstanceId: string): Verification {
  if (manifest.instance_id !== expectedInstanceId) {
    return { verified: false, running: false, detail: "manifest belongs to a different instance" };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid >= 0 && manifest.uid !== uid) {
    return {
      verified: false,
      running: false,
      detail: `manifest uid ${manifest.uid} != current uid ${uid}`,
    };
  }
  if (!pidAlive(manifest.pid)) {
    return { verified: true, running: false, detail: `pid ${manifest.pid} is not running` };
  }
  const args = psArgs(manifest.pid);
  if (args === undefined) {
    return { verified: false, running: true, detail: `cannot read argv of pid ${manifest.pid}` };
  }
  // ps joins argv with single spaces; argv elements may themselves contain
  // whitespace, so verify by anchored substrings, not token equality.
  const head = `${wrapperPath()} --kiwi-nonce ${manifest.nonce} `;
  if (!args.includes(head)) {
    return {
      verified: false,
      running: true,
      detail: `pid ${manifest.pid} lacks the expected nonce/wrapper signature`,
    };
  }
  // Tamper check: the stored fingerprint must match the stored argv.
  if (fingerprint(manifest.wrapper_argv) !== manifest.command_fingerprint) {
    return { verified: false, running: true, detail: "command fingerprint mismatch" };
  }
  return { verified: true, running: true, detail: `pid ${manifest.pid} verified (nonce match)` };
}
