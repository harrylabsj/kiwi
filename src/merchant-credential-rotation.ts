/** Safe client for shopping-cli's merchant credential prepare/confirm protocol. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fs/atomic-write.js";
import { readJsonBody } from "./net/safe-http.js";
import { isLoopbackHost } from "./a2a/client/url-policy.js";

export interface MerchantCredentialRotationOptions {
  baseUrl: string;
  merchantId: string;
  tokenEnv: string;
  credentialsPath: string;
  pendingPath: string;
  operationLockPath?: string;
  fetchImpl?: typeof fetch;
  runningServices?: () => string[];
  beginRuntimeSwitch?: () => void;
  endRuntimeSwitch?: () => void;
  waitForRuntimeCredential?: (token: string) => Promise<void>;
  stopServices?: (services: string[]) => Promise<void>;
  startRuntime?: (services: string[]) => Promise<void>;
  randomToken?: () => string;
  randomRotationId?: () => string;
  beforeRotation?: () => void;
}

export function credentialFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface MerchantCredentialExpiry {
  createdAt: string;
  expiresAt: string;
  lifetimeSeconds: number | null;
  secondsRemaining: number | null;
  tokenPrefix: string;
}

export class MerchantTokenStatusError extends Error {
  constructor(cause?: unknown) {
    super("merchant token status is unavailable", { cause });
  }
}

/** Read current token expiry through the protected, non-secret status route. */
export async function inspectMerchantCredentialExpiry(
  options: Pick<MerchantCredentialRotationOptions, "baseUrl" | "merchantId" | "tokenEnv" | "credentialsPath" | "fetchImpl"> & { now?: () => Date },
): Promise<MerchantCredentialExpiry> {
  const base = validateBaseUrl(options.baseUrl);
  const token = readToken(options.credentialsPath, options.tokenEnv);
  const url = endpointUrl(base, `/merchants/${encodeURIComponent(options.merchantId)}/token/status`);
  let status: Record<string, unknown>;
  try {
    status = await requestJson(options.fetchImpl ?? fetch, url, token);
  } catch (error) {
    throw new MerchantTokenStatusError(error);
  }
  if (status.merchant_id !== options.merchantId || status.active !== true || typeof status.created_at !== "string" || typeof status.expires_at !== "string" || typeof status.token_prefix !== "string") {
    throw new Error("shopping-cli returned invalid merchant token status");
  }
  if (status.expires_at === "") return { createdAt: status.created_at, expiresAt: "", lifetimeSeconds: null, secondsRemaining: null, tokenPrefix: status.token_prefix };
  const expiresMs = Date.parse(status.expires_at);
  const createdMs = Date.parse(status.created_at);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(createdMs) || expiresMs <= createdMs) throw new Error("shopping-cli returned an invalid merchant token lifetime");
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  return {
    createdAt: status.created_at,
    expiresAt: status.expires_at,
    lifetimeSeconds: Math.floor((expiresMs - createdMs) / 1000),
    secondsRemaining: Math.floor((expiresMs - nowMs) / 1000),
    tokenPrefix: status.token_prefix,
  };
}

/** Rotate automatically only inside the configured pre-expiry window; resume an existing recovery sidecar first. */
export async function rotateMerchantCredentialIfDue(
  options: MerchantCredentialRotationOptions & { rotateBeforeSeconds: number; now?: () => Date },
): Promise<{ status: "rotated" | "not_due" | "no_expiry"; expiresAt: string; secondsRemaining: number | null; result?: Awaited<ReturnType<typeof rotateMerchantCredential>> }> {
  if (!Number.isSafeInteger(options.rotateBeforeSeconds) || options.rotateBeforeSeconds < 0) throw new Error("rotateBeforeSeconds must be a non-negative whole number");
  const release = acquireRotationLock(options.operationLockPath ?? `${options.credentialsPath}.rotation.lock`);
  try {
    if (existsSync(options.pendingPath)) {
      options.beforeRotation?.();
      return { status: "rotated", expiresAt: "", secondsRemaining: null, result: await performMerchantCredentialRotation(options) };
    }
    const expiry = await inspectMerchantCredentialExpiry(options);
    if (expiry.secondsRemaining === null || expiry.lifetimeSeconds === null) return { status: "no_expiry", expiresAt: "", secondsRemaining: null };
    // Avoid a tight rotation loop when the server token TTL is shorter than the configured lead time.
    const effectiveLead = Math.min(options.rotateBeforeSeconds, Math.max(60, Math.floor(expiry.lifetimeSeconds / 5)));
    if (expiry.secondsRemaining > effectiveLead) return { status: "not_due", expiresAt: expiry.expiresAt, secondsRemaining: expiry.secondsRemaining };
    options.beforeRotation?.();
    return { status: "rotated", expiresAt: expiry.expiresAt, secondsRemaining: expiry.secondsRemaining, result: await performMerchantCredentialRotation(options) };
  } finally {
    release();
  }
}

interface PendingRotation {
  version: 1;
  merchant_id: string;
  token_env: string;
  base_url: string;
  rotation_id: string;
  previous_token: string;
  replacement_token: string;
  restart_services?: string[];
}

class CredentialIdentityMismatchError extends Error {
  constructor() {
    super("previous credential verified against the wrong merchant");
  }
}

class RotationLockBusyError extends Error {
  constructor(message: string) { super(message); }
}

function acquireRotationLock(file: string): () => void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockId = randomUUID();
  const create = (): void => writeFileSync(file, `${JSON.stringify({ pid: process.pid, lock_id: lockId })}\n`, { mode: 0o600, flag: "wx" });
  try {
    create();
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    let pid = 0;
    try { pid = Number((JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid); }
    catch { throw new Error("merchant credential rotation lock is unreadable; preserve it for manual recovery"); }
    let alive = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; }
      catch (probeError) { alive = (probeError as { code?: string }).code === "EPERM"; }
    }
    if (alive || pid <= 0) throw new RotationLockBusyError("another merchant credential rotation is already running");
    rmSync(file, { force: true });
    try { create(); } catch { throw new RotationLockBusyError("another merchant credential rotation started concurrently; retry later"); }
  }
  return () => {
    try {
      const owner = JSON.parse(readFileSync(file, "utf8")) as { lock_id?: unknown };
      if (owner.lock_id === lockId) rmSync(file, { force: true });
    } catch { /* not our lock */ }
  };
}

function readToken(file: string, tokenEnv: string): string {
  if (!existsSync(file)) throw new Error(`${tokenEnv} is missing from the protected credentials file`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("credentials target must be a regular file");
  // 只读路径绝不改权限：`kiwi merchant doctor` 与 5 分钟一次的状态检查都会走
  // 这里，改 0400 → 0600 属于未声明的副作用（文档承诺只读命令不改文件）。
  const text = readFileSync(file, "utf8");
  const key = tokenEnv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...text.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=([^\\r\\n]*)`, "gm"))];
  if (matches.length !== 1 || !matches[0]?.[1]?.trim()) throw new Error(`credentials file must contain exactly one ${tokenEnv}`);
  return matches[0][1].trim();
}

function writeToken(file: string, tokenEnv: string, token: string): void {
  if (/[\r\n\0]/.test(token)) throw new Error("merchant token must be a single-line value");
  let previous = "";
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("credentials target must be a regular file");
    previous = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const key = tokenEnv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const target = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[^\\r\\n]*`, "gm");
  const content = target.test(previous)
    ? previous.replace(target, `${tokenEnv}=${token}`)
    : `${previous}${previous !== "" && !previous.endsWith("\n") ? "\n" : ""}${tokenEnv}=${token}\n`;
  writeFileAtomic(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
  process.env[tokenEnv] = token;
}

function readPending(file: string): PendingRotation | undefined {
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("pending rotation state must be a regular file");
  chmodSync(file, 0o600);
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PendingRotation>;
  if (value.version !== 1 || typeof value.merchant_id !== "string" || typeof value.token_env !== "string" || typeof value.base_url !== "string" ||
      typeof value.rotation_id !== "string" || typeof value.previous_token !== "string" || typeof value.replacement_token !== "string") {
    throw new Error("pending rotation state is invalid; refusing to overwrite credentials");
  }
  return value as PendingRotation;
}

function validateBaseUrl(raw: string): URL {
  const url = new URL(raw);
  // `isLoopbackHost` 会去掉 IPv6 字面量的方括号（Node 里 `new URL("http://[::1]")`
  // 的 hostname 是 `[::1]`），否则 IPv6 回环会被误判成非回环而拒绝。
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))) {
    throw new Error("shopping-cli rotation requires HTTPS (HTTP is allowed only for loopback)");
  }
  return url;
}

/**
 * 拼接端点时必须保留 `base_url` 里的路径前缀：网关可以挂在 `/shopping`
 * 之类的子路径下，`HttpMerchantClient` 也是 `${baseUrl}${pathname}` 的口径。
 */
function endpointUrl(base: URL, pathname: string): URL {
  return new URL(`${base.href.replace(/\/+$/, "")}${pathname}`);
}

/** 用于 sidecar 归属判断的规范化 API 身份（忽略结尾斜杠与回环写法差异）。 */
function canonicalApiIdentity(raw: string): string {
  const url = new URL(raw);
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  const host = isLoopbackHost(url.hostname) ? "loopback" : url.hostname.toLowerCase();
  return `${url.protocol}//${host}:${port}${url.pathname.replace(/\/+$/, "")}`;
}

async function requestJson(fetchImpl: typeof fetch, url: URL, token: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("shopping-cli refused a redirect during credential rotation");
    }
    let payload: unknown = {};
    try {
      // 与其它出站调用同口径：响应体有上限，避免故障/恶意网关把常驻 supervisor 撑爆。
      payload = await readJsonBody(response, { signal: controller.signal, maxBytes: 64 * 1024 });
    } catch {
      payload = {};
    }
    if (!response.ok) throw Object.assign(new Error(`shopping-cli credential rotation request failed (HTTP ${response.status})`), { status: response.status });
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("shopping-cli returned an invalid credential rotation response");
    return payload as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function newPending(options: MerchantCredentialRotationOptions, previous: string): PendingRotation {
  return {
    version: 1,
    merchant_id: options.merchantId,
    token_env: options.tokenEnv,
    base_url: options.baseUrl,
    rotation_id: options.randomRotationId?.() ?? randomBytes(24).toString("base64url"),
    previous_token: previous,
    replacement_token: options.randomToken?.() ?? `shopping_merchant_${randomBytes(32).toString("base64url")}`,
  };
}

/** Resume a pending rotation or start one. Secrets are staged before any request. */
async function performMerchantCredentialRotation(options: MerchantCredentialRotationOptions): Promise<{ rotated: boolean; recovered: boolean; restarted: string[] }> {
  const base = validateBaseUrl(options.baseUrl);
  mkdirSync(path.dirname(options.credentialsPath), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(options.pendingPath), { recursive: true, mode: 0o700 });
  const fetchImpl = options.fetchImpl ?? fetch;
  const onDisk = readToken(options.credentialsPath, options.tokenEnv);
  let pending = readPending(options.pendingPath);
  let recovered = pending !== undefined;
  const sameApi = (a: string, b: string): boolean => {
    try {
      return canonicalApiIdentity(a) === canonicalApiIdentity(b);
    } catch {
      return a === b;
    }
  };
  if (pending !== undefined && (pending.merchant_id !== options.merchantId || pending.token_env !== options.tokenEnv || !sameApi(pending.base_url, options.baseUrl))) {
    throw new Error("pending rotation belongs to another merchant or API; use that profile to recover it");
  }
  if (pending === undefined) {
    pending = newPending(options, onDisk);
    writeFileAtomic(options.pendingPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
    chmodSync(options.pendingPath, 0o600);
  } else if (onDisk !== pending.previous_token && onDisk !== pending.replacement_token) {
    throw new Error("credentials changed during a pending rotation; refusing to overwrite them");
  }

  const root = endpointUrl(base, `/merchants/${encodeURIComponent(options.merchantId)}/token/rotate/prepare`);
  const confirmUrl = endpointUrl(base, `/merchants/${encodeURIComponent(options.merchantId)}/token/rotate/confirm`);
  const privateUrl = endpointUrl(base, `/merchants/${encodeURIComponent(options.merchantId)}/private-config`);

  const finishConfirmed = async (state: PendingRotation) => {
    const restarted = state.restart_services ?? [];
    options.endRuntimeSwitch?.();
    rmSync(options.pendingPath, { force: true });
    return { rotated: true, recovered, restarted };
  };

  // If a prior attempt already staged the replacement into credentials.env,
  // resolve the ambiguous confirm boundary with replacement proof first.
  if (onDisk === pending.replacement_token) {
    let verifiedNew = false;
    try {
      const verified = await requestJson(fetchImpl, privateUrl, pending.replacement_token);
      if (verified.merchant_id !== options.merchantId) throw new Error("replacement credential verified against the wrong merchant");
      verifiedNew = true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 401 && status !== 403) throw error;
      // A rejection of the new credential says nothing about the previous one.
      // Probe the previous token explicitly before changing local state.
      const verifiedOld = await requestJson(fetchImpl, privateUrl, pending.previous_token).catch((oldError: unknown) => {
        if ((oldError as { status?: number }).status === 401 || (oldError as { status?: number }).status === 403) {
          throw new Error("neither pending nor previous credential is accepted; use admin recovery and keep the sidecar for diagnosis", { cause: oldError });
        }
        throw oldError;
      });
      if (verifiedOld.merchant_id !== options.merchantId) throw new CredentialIdentityMismatchError();
      const running = options.runningServices?.() ?? [];
      options.beginRuntimeSwitch?.();
      await options.stopServices?.(running);
      writeToken(options.credentialsPath, options.tokenEnv, pending.previous_token);
      pending = { ...newPending(options, pending.previous_token), ...(pending.restart_services !== undefined ? { restart_services: pending.restart_services } : {}) };
      writeFileAtomic(options.pendingPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
      chmodSync(options.pendingPath, 0o600);
    }
    if (verifiedNew) {
      const running = options.runningServices?.() ?? [];
      pending = { ...pending, restart_services: [...new Set([...(pending.restart_services ?? []), ...running])] };
      writeFileAtomic(options.pendingPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
      options.beginRuntimeSwitch?.();
      await options.stopServices?.(running);
      await options.startRuntime?.(pending.restart_services ?? []);
      // 只有 A2A 子进程会写自证；只重启了 mcp 时强制等待它等于必然超时。
      if ((pending.restart_services ?? []).includes("a2a")) {
        if (options.waitForRuntimeCredential === undefined) throw new Error("managed runtime credential probe is required before confirmation");
        await options.waitForRuntimeCredential(pending.replacement_token);
      }
      const confirmed = await requestJson(fetchImpl, confirmUrl, pending.replacement_token, { rotation_id: pending.rotation_id });
      if (confirmed.status !== "confirmed") throw new Error("shopping-cli did not confirm the credential rotation");
      return await finishConfirmed(pending);
    }
  }

  // On network failure the secure sidecar intentionally remains for exact retry.
  let prepared: Record<string, unknown> = await requestJson(fetchImpl, root, pending.previous_token, {
    rotation_id: pending.rotation_id,
    replacement_token: pending.replacement_token,
  });
  if (prepared.status === "expired") {
    pending = { ...newPending(options, pending.previous_token), ...(pending.restart_services !== undefined ? { restart_services: pending.restart_services } : {}) };
    writeFileAtomic(options.pendingPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
    chmodSync(options.pendingPath, 0o600);
    prepared = await requestJson(fetchImpl, root, pending.previous_token, {
      rotation_id: pending.rotation_id,
      replacement_token: pending.replacement_token,
    });
  }
  if (prepared.status !== "pending" && prepared.status !== "confirmed") throw new Error("shopping-cli returned an unexpected rotation state");
  const verified = await requestJson(fetchImpl, privateUrl, pending.replacement_token);
  if (verified.merchant_id !== options.merchantId) throw new Error("replacement credential verified against the wrong merchant");

  const running = options.runningServices?.() ?? [];
  pending = { ...pending, restart_services: [...new Set([...(pending.restart_services ?? []), ...running])] };
  // Persist recovery intent before stopping or changing the active credential.
  writeFileAtomic(options.pendingPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
  options.beginRuntimeSwitch?.();
  await options.stopServices?.(running);
  writeToken(options.credentialsPath, options.tokenEnv, pending.replacement_token);
  await options.startRuntime?.(pending.restart_services ?? []);
  if ((pending.restart_services ?? []).includes("a2a")) {
    if (options.waitForRuntimeCredential === undefined) throw new Error("managed runtime credential probe is required before confirmation");
    await options.waitForRuntimeCredential(pending.replacement_token);
  }
  const confirmed = await requestJson(fetchImpl, confirmUrl, pending.replacement_token, { rotation_id: pending.rotation_id });
  if (confirmed.status !== "confirmed") throw new Error("shopping-cli did not confirm the credential rotation");
  return await finishConfirmed(pending);
}

export async function rotateMerchantCredential(options: MerchantCredentialRotationOptions): Promise<{ rotated: boolean; recovered: boolean; restarted: string[] }> {
  const release = acquireRotationLock(options.operationLockPath ?? `${options.credentialsPath}.rotation.lock`);
  try {
    return await performMerchantCredentialRotation(options);
  } finally {
    // 切换标记只用于覆盖 stop→start 这段窗口。任何失败路径都必须清掉它，
    // 否则 supervisor 的 reconcile 会永远拒绝拉起子服务，实例被卡死（只能
    // 手工删文件），而宁可让子进程带着磁盘上现有的 token 先跑起来。
    options.endRuntimeSwitch?.();
    release();
  }
}
