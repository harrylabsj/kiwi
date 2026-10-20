import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

export interface OwnedClockIdentity {
  provider: "DARWIN_MACH_CONTINUOUS_NS" | "LINUX_PROC_UPTIME_NS";
  host: string;
  bootId: string;
  namespace: string | null;
  resolutionNs: string;
}

export interface OwnedClockSample extends OwnedClockIdentity {
  wallMs: number;
  monotonicNs: string;
}

export interface OwnedClock {
  readonly identity: OwnedClockIdentity;
  read(): OwnedClockSample;
}

const UUID = /^[a-f0-9-]{36}$/i;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function darwinBootId(execFile: typeof execFileSync): string {
  let value: string;
  try {
    value = execFile("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 1000 }).trim();
  } catch {
    return fail("OWNED_CLOCK_BOOT_ID_UNKNOWN");
  }
  if (!UUID.test(value)) return fail("OWNED_CLOCK_BOOT_ID_UNKNOWN");
  return value.toUpperCase();
}

function linuxBootId(readFile: typeof fs.readFileSync): string {
  let value: string;
  try {
    value = readFile("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return fail("OWNED_CLOCK_BOOT_ID_UNKNOWN");
  }
  if (!UUID.test(value)) return fail("OWNED_CLOCK_BOOT_ID_UNKNOWN");
  return value.toLowerCase();
}

function linuxNamespace(readlink: typeof fs.readlinkSync): string {
  let value: string;
  try {
    value = readlink("/proc/self/ns/time");
  } catch {
    return fail("OWNED_CLOCK_NAMESPACE_UNKNOWN");
  }
  if (!/^time:\[\d+\]$/.test(value)) return fail("OWNED_CLOCK_NAMESPACE_UNKNOWN");
  return value;
}

function linuxUptimeNs(readFile: typeof fs.readFileSync): bigint {
  let value: string;
  try {
    value = readFile("/proc/uptime", "utf8");
  } catch {
    return fail("OWNED_CLOCK_MONOTONIC_UNKNOWN");
  }
  const match = /^(\d+)\.(\d{2})\s+\S+(?:\s|$)/.exec(value);
  if (!match) return fail("OWNED_CLOCK_MONOTONIC_UNKNOWN");
  return BigInt(match[1]!) * 1_000_000_000n + BigInt(match[2]!) * 10_000_000n;
}

export function createOwnedClock(options: {
  platform?: typeof process.platform;
  uvVersion?: string;
  hostname?: string;
  readFile?: typeof fs.readFileSync;
  readlink?: typeof fs.readlinkSync;
  execFile?: typeof execFileSync;
  hrtime?: () => bigint;
} = {}): OwnedClock {
  const platform = options.platform ?? process.platform;
  const hostname = options.hostname ?? os.hostname();
  const readFile = options.readFile ?? fs.readFileSync;
  const readlink = options.readlink ?? fs.readlinkSync;
  const execFile = options.execFile ?? execFileSync;
  const hrtime = options.hrtime ?? (() => process.hrtime.bigint());
  let identity: OwnedClockIdentity;
  if (platform === "darwin") {
    if ((options.uvVersion ?? process.versions.uv) !== "1.51.0") return fail("OWNED_CLOCK_PROVIDER_UNKNOWN");
    identity = { provider: "DARWIN_MACH_CONTINUOUS_NS", host: hostname, bootId: darwinBootId(execFile), namespace: null, resolutionNs: "1000000" };
  } else if (platform === "linux") {
    identity = { provider: "LINUX_PROC_UPTIME_NS", host: hostname, bootId: linuxBootId(readFile), namespace: linuxNamespace(readlink), resolutionNs: "10000000" };
  } else {
    return fail("OWNED_CLOCK_PROVIDER_UNKNOWN");
  }
  const read = (): OwnedClockSample => {
    const liveHost = os.hostname();
    const liveBoot = platform === "darwin" ? darwinBootId(execFile) : linuxBootId(readFile);
    const liveNamespace = platform === "linux" ? linuxNamespace(readlink) : null;
    if (liveHost !== identity.host || liveBoot !== identity.bootId || liveNamespace !== identity.namespace) return fail("OWNED_CLOCK_IDENTITY_DRIFT");
    let monotonicNs: bigint;
    try {
      monotonicNs = platform === "darwin" ? hrtime() : linuxUptimeNs(readFile);
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith("OWNED_CLOCK_")) throw error;
      return fail("OWNED_CLOCK_MONOTONIC_UNKNOWN");
    }
    return { ...identity, wallMs: Date.now(), monotonicNs: monotonicNs.toString() };
  };
  return Object.freeze({ identity: Object.freeze(identity), read });
}

export function ownedHostBootId(identity: OwnedClockIdentity): string {
  return `${identity.host}:${identity.bootId}`;
}
