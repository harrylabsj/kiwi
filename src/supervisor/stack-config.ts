/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Stack config (`kiwi.stack.json`) — the self-contained instance definition
 * written by `kiwi init` and consumed by up/status/logs/down.
 *
 * Parsing is fail-closed: unknown fields at every level are rejected, types
 * are checked, and instance-directory safety rules refuse broad targets
 * (filesystem root, the user's home, /tmp itself, …). Secrets never appear
 * in this file: profiles and env mappings only NAME environment variables.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const STACK_VERSION = 1;
export const STACK_CONFIG_FILE = "kiwi.stack.json";

export type StackMode = "managed-local" | "connected";
export type ManagedRole = "gateway" | "merchant" | "buyer";
export const MANAGED_ROLES: readonly ManagedRole[] = ["gateway", "merchant", "buyer"];

export interface StackAgentConfig {
  enabled: boolean;
  /** Path to the agent profile, relative to the instance dir. */
  profile: string;
}

export interface StackConfig {
  stack_version: number;
  /** Random per-instance id; binds manifests to this instance. */
  instance_id: string;
  mode: StackMode;
  created_at: string;
  gateway: {
    base_url: string;
    /** Exact argv for the shopping-cli API server (never a shell string). */
    command: string[];
    /** Extra environment for the gateway child (e.g. PYTHONPATH). */
    env: Record<string, string>;
  };
  agents: {
    merchant: StackAgentConfig;
    buyer: StackAgentConfig;
  };
}

export class StackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackConfigError";
  }
}

function fail(message: string): never {
  throw new StackConfigError(message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rejectUnknown(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  section: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`stack config: ${section} has unknown field "${key}"`);
  }
}

/** Instance layout: the only paths the supervisor ever creates or removes. */
export function instancePaths(dir: string): {
  root: string;
  config: string;
  data: string;
  logs: string;
  run: string;
  profiles: string;
} {
  const root = path.resolve(dir);
  return {
    root,
    config: path.join(root, STACK_CONFIG_FILE),
    data: path.join(root, "data"),
    logs: path.join(root, "logs"),
    run: path.join(root, "run"),
    profiles: path.join(root, "profiles"),
  };
}

/**
 * Directories that may never become an instance target: the supervisor
 * creates/deletes state there, so broad roots are refused outright.
 */
function blockedInstanceDirs(): Set<string> {
  const home = path.resolve(homedir());
  return new Set([
    path.parse(home).root, // filesystem root ("/")
    home,
    path.dirname(home), // "/Users" or "/home"
    "/tmp",
    "/var",
    "/etc",
    "/usr",
    "/opt",
  ]);
}

/** Resolve and validate an instance directory for init. */
export function assertSafeInstanceDir(dir: string): string {
  const resolved = path.resolve(dir);
  if (blockedInstanceDirs().has(resolved)) {
    fail(`refusing unsafe instance directory: ${resolved}`);
  }
  const segments = resolved.split(path.sep).filter((s) => s.length > 0);
  if (segments.length < 2) {
    fail(`refusing too-broad instance directory: ${resolved}`);
  }
  return resolved;
}

/** Hosts allowed to use cleartext HTTP for a managed-local gateway. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Structurally validate gateway.base_url: no credentials, no fragment, no
 * query. managed-local must be cleartext HTTP on a loopback host with an
 * explicit valid port; connected may be HTTPS (any host) and keeps the same
 * loopback-only rule for HTTP.
 */
export function validateGatewayBaseUrl(value: unknown, mode: StackMode, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${source}: gateway.base_url is required`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${source}: gateway.base_url must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`${source}: gateway.base_url must use http or https (got ${url.protocol})`);
  }
  if (url.username !== "" || url.password !== "") {
    fail(`${source}: gateway.base_url must not embed credentials`);
  }
  if (url.hash !== "" || url.search !== "") {
    fail(`${source}: gateway.base_url must not contain a fragment or query`);
  }
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
  if (mode === "managed-local") {
    if (url.protocol !== "http:" || !loopback) {
      fail(`${source}: managed-local gateway.base_url must be HTTP on a loopback host`);
    }
    // Explicit valid port is required for the managed gateway.
    if (!/^\d+$/.test(url.port)) {
      fail(`${source}: managed-local gateway.base_url must carry an explicit port`);
    }
    const port = Number(url.port);
    if (port < 1 || port > 65535) {
      fail(`${source}: gateway.base_url port must be between 1 and 65535`);
    }
  } else if (url.protocol === "http:" && !loopback) {
    fail(`${source}: gateway.base_url uses cleartext HTTP; only loopback hosts may use HTTP`);
  }
  return value;
}

/**
 * Resolve an agent profile path against the instance root and prove
 * containment. Absolute paths and traversal escaping the root are rejected;
 * harmless filenames containing two dots are fine.
 */
export function resolveProfilePath(instanceRoot: string, profile: string, source: string): string {
  if (path.isAbsolute(profile)) {
    fail(`${source}: agent profile must be a relative path inside the instance`);
  }
  const root = path.resolve(instanceRoot);
  const resolved = path.resolve(root, profile);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    fail(`${source}: agent profile escapes the instance directory: ${profile}`);
  }
  return resolved;
}

/** Validate a parsed stack config object, fail closed. */
export function validateStackConfig(data: unknown, source: string): StackConfig {
  if (!isObject(data)) fail(`${source}: stack config must be a JSON object`);
  rejectUnknown(
    data,
    ["stack_version", "instance_id", "mode", "created_at", "gateway", "agents"],
    "root",
  );
  if (data.stack_version !== STACK_VERSION) {
    fail(`${source}: stack_version must be ${STACK_VERSION}`);
  }
  if (typeof data.instance_id !== "string" || !/^[0-9a-f]{32}$/.test(data.instance_id)) {
    fail(`${source}: instance_id must be a 32-char hex string`);
  }
  if (data.mode !== "managed-local" && data.mode !== "connected") {
    fail(`${source}: mode must be managed-local or connected`);
  }
  if (typeof data.created_at !== "string" || Number.isNaN(Date.parse(data.created_at))) {
    fail(`${source}: created_at must be an ISO timestamp`);
  }

  if (!isObject(data.gateway)) fail(`${source}: gateway section is required`);
  const gw = data.gateway;
  rejectUnknown(gw, ["base_url", "command", "env"], "gateway");
  const baseUrl = validateGatewayBaseUrl(gw.base_url, data.mode, source);
  if (
    !Array.isArray(gw.command) ||
    gw.command.length === 0 ||
    !gw.command.every((c) => typeof c === "string" && c.length > 0)
  ) {
    fail(
      `${source}: gateway.command must be a non-empty string array (argv, never a shell string)`,
    );
  }
  if (!isObject(gw.env) || !Object.values(gw.env).every((v) => typeof v === "string")) {
    fail(`${source}: gateway.env must be a string map`);
  }

  if (!isObject(data.agents)) fail(`${source}: agents section is required`);
  rejectUnknown(data.agents, ["merchant", "buyer"], "agents");
  const parseAgent = (value: unknown, name: string): StackAgentConfig => {
    if (!isObject(value)) fail(`${source}: agents.${name} must be an object`);
    rejectUnknown(value, ["enabled", "profile"], `agents.${name}`);
    if (typeof value.enabled !== "boolean")
      fail(`${source}: agents.${name}.enabled must be a boolean`);
    if (typeof value.profile !== "string" || value.profile.length === 0) {
      fail(`${source}: agents.${name}.profile must be a non-empty string`);
    }
    if (path.isAbsolute(value.profile)) {
      fail(`${source}: agents.${name}.profile must be a relative path inside the instance`);
    }
    // Normalized traversal out of the configured location is rejected here;
    // full containment inside the instance root is proven at load/use time
    // via resolveProfilePath. Filenames containing ".." harmlessly (e.g.
    // "merchant.v1..yaml") are allowed.
    const normalized = path.posix.normalize(value.profile.split(path.sep).join("/"));
    if (normalized === ".." || normalized.startsWith("../")) {
      fail(`${source}: agents.${name}.profile must not traverse outside its directory`);
    }
    return { enabled: value.enabled, profile: value.profile };
  };

  return {
    stack_version: STACK_VERSION,
    instance_id: data.instance_id,
    mode: data.mode,
    created_at: data.created_at,
    gateway: {
      base_url: baseUrl,
      command: gw.command as string[],
      env: { ...(gw.env as Record<string, string>) },
    },
    agents: {
      merchant: parseAgent(data.agents.merchant, "merchant"),
      buyer: parseAgent(data.agents.buyer, "buyer"),
    },
  };
}

/** Parse and validate a stack config from raw text. */
export function parseStackConfig(raw: string, source: string): StackConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    fail(`${source}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateStackConfig(data, source);
}

/** A free loopback port (best effort; the usual bind-after-close race applies). */
export async function pickFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || (typeof address === "object") !== true) {
        server.close();
        reject(new StackConfigError("could not allocate a free loopback port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export function newInstanceId(): string {
  return randomBytes(16).toString("hex");
}

/** Detect a nearby shopping-cli source checkout.
 *
 * Local development keeps the repositories as siblings, while composition CI
 * checks the pinned consumer out below the Kiwi workspace. Support both
 * layouts so `kiwi init` remains deterministic in either environment.
 */
export function detectShoppingCliSrc(packageRoot: string): string | undefined {
  const candidates = [
    path.resolve(packageRoot, "..", "shopping-cli"),
    path.resolve(packageRoot, "shopping-cli"),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "shopping_cli")));
}
