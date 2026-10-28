import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentProfile } from "../config/profile.js";
import { DEFAULT_CREDENTIALS_ENV_PATH, inspectMerchantCredentialStorage } from "../product-init.js";
import { inspectMerchantCredentialExpiry } from "../merchant-credential-rotation.js";
import type { ManagedServiceState } from "./manager.js";
import { readEnrollmentStore } from "../cloud/binding/enrollment-challenge.js";
import { A2A_SIGNING_KEY_FILE, loadA2aSigningIdentityFromFile } from "../a2a/signing-key.js";
import { publicKeyThumbprint } from "../trust/binding/thumbprint.js";

export interface MerchantDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  state: "ok" | "failed" | "unknown";
}

export interface MerchantDoctorReport {
  ok: boolean;
  status: "ok" | "unknown" | "failed";
  merchant_id: string;
  checks: MerchantDoctorCheck[];
}

function processMatches(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 }).trim();
    return command.includes("merchant") && command.includes("runtime");
  } catch {
    return false;
  }
}

export async function runMerchantCredentialDoctor(input: {
  profile: AgentProfile;
  dataDir: string;
  services: ManagedServiceState[];
  credentialsPath?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  processCheck?: (pid: number) => boolean;
}): Promise<MerchantDoctorReport> {
  const { profile } = input;
  const checks: MerchantDoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail, state: ok ? "ok" : "failed" }); };
  const addUnknown = (name: string, detail: string): void => { checks.push({ name, ok: true, detail, state: "unknown" }); };
  const catalogTokenEnv = profile.commerce.credentials?.catalog?.token_env;
  const refsDistinct = catalogTokenEnv === undefined || catalogTokenEnv !== profile.commerce.token_env;
  add("credential_scope", refsDistinct, refsDistinct
    ? `shopping-cli token uses ${profile.commerce.token_env}; Catalog credential is separate`
    : `shopping-cli token env ${profile.commerce.token_env} aliases the Catalog credential`);

  const credentialsPath = input.credentialsPath ?? DEFAULT_CREDENTIALS_ENV_PATH;
  const storage = inspectMerchantCredentialStorage(profile.commerce.token_env, credentialsPath);
  const storageOk = storage.status === "ready";
  const storageDetail = storage.status === "ready"
    ? `protected credentials file is ready (mode ${storage.mode.toString(8)})`
    : storage.status === "missing_file"
      ? "protected credentials file is missing; automatic rotation cannot recover safely"
      : storage.status === "unsafe_file"
        ? `credentials file is not a private regular file${storage.mode === undefined ? "" : ` (mode ${storage.mode.toString(8)})`}`
        : storage.status === "duplicate_token"
          ? `${profile.commerce.token_env} appears multiple times in the credentials file`
          : `${profile.commerce.token_env} is not stored in the credentials file`;
  add("credential_storage", storageOk, storageDetail);

  const runtimeDir = path.join(input.dataDir, "runtime");
  const pendingPath = path.join(path.dirname(credentialsPath), "credential-rotation.json");
  let pending = false;
  if (existsSync(pendingPath)) {
    try {
      const stat = lstatSync(pendingPath);
      const state = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, unknown>;
      pending = stat.isFile() && !stat.isSymbolicLink() && state.version === 1 && state.merchant_id === profile.agent_id;
    } catch { pending = false; }
    add("rotation_recovery", false, pending
      ? "a pending rotation sidecar exists; run kiwi merchant credentials recover"
      : "rotation sidecar is malformed or belongs to another merchant; preserve it for recovery");
  } else {
    add("rotation_recovery", true, "no pending rotation sidecar");
  }
  const switchMarker = path.join(runtimeDir, "credential-rotation.lock");
  add("runtime_switch", !existsSync(switchMarker), existsSync(switchMarker)
    ? "credential switch marker is active; finish recovery before expecting managed services to relaunch"
    : "no credential switch is in progress");
  const operationLock = path.join(path.dirname(credentialsPath), "credential-rotation-operation.lock");
  if (existsSync(operationLock)) {
    let active = false;
    try {
      const lock = JSON.parse(readFileSync(operationLock, "utf8")) as { pid?: unknown };
      const pid = Number(lock.pid);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); active = true; }
        catch (error) { active = (error as { code?: string }).code === "EPERM"; }
      }
    } catch { active = false; }
    add("rotation_operation", false, active
      ? "a credential rotation process is active"
      : "rotation operation lock is stale or unreadable; inspect it before removing it");
  } else {
    add("rotation_operation", true, "no rotation operation is running");
  }

  const activeServices = input.services.filter((service) => service.running).map((service) => service.name);
  add("managed_services", true, activeServices.length > 0
    ? `running: ${activeServices.join(", ")}`
    : "no managed services are running");

  let enrollmentSessions: Array<{ status: string; key_thumbprint?: string }> = [];
  try {
    const enrollmentPath = path.join(input.dataDir, "merchant-enrollments.json");
    if (existsSync(enrollmentPath)) {
      const enrollmentStat = lstatSync(enrollmentPath);
      if (!enrollmentStat.isFile() || enrollmentStat.isSymbolicLink() || (enrollmentStat.mode & 0o077) !== 0) throw new Error("unsafe enrollment file");
    }
    enrollmentSessions = readEnrollmentStore(input.dataDir).sessions;
    const published = enrollmentSessions.filter((session) => session.status === "published");
    const pending = enrollmentSessions.filter((session) => ["preparing", "authorized", "bound"].includes(session.status));
    add("enrollment_local", published.length > 0, published.length > 0
      ? `local store has ${published.length} published enrollment record(s)`
      : pending.length > 0 ? `local enrollment is ${pending[0]?.status}; Catalog publication is not locally complete` : "no local published enrollment record");
  } catch {
    add("enrollment_local", false, "local enrollment store is malformed or unreadable");
  }

  const keyPath = path.join(input.dataDir, A2A_SIGNING_KEY_FILE);
  const publishedThumbprints = new Set(enrollmentSessions.filter((session) => session.status === "published")
    .map((session) => session.key_thumbprint).filter((value): value is string => typeof value === "string"));
  if (!existsSync(keyPath)) {
    if (publishedThumbprints.size > 0) add("runtime_signing_key", false, "published enrollment exists but its local signing key is missing");
    else addUnknown("runtime_signing_key", "local signing key is not present; enrollment has not established a key yet");
  } else {
    try {
      const keyStat = lstatSync(keyPath);
      if (!keyStat.isFile() || keyStat.isSymbolicLink() || (keyStat.mode & 0o077) !== 0) throw new Error("unsafe key file");
      const identity = loadA2aSigningIdentityFromFile(keyPath);
      const thumbprint = publicKeyThumbprint(identity.publicKeyPem);
      const matchesPublished = publishedThumbprints.size === 0 || publishedThumbprints.has(thumbprint);
      add("runtime_signing_key", matchesPublished, matchesPublished
        ? `local Ed25519 key is readable and private (mode ${(keyStat.mode & 0o777).toString(8)})`
        : "local signing key does not match any published enrollment thumbprint");
    } catch {
      add("runtime_signing_key", false, "local signing key is malformed, unreadable, or not private");
    }
  }

  const heartbeatPath = path.join(input.dataDir, "merchant-enrollment-heartbeat.json");
  if (!existsSync(heartbeatPath)) {
    addUnknown("enrollment_heartbeat", "no local signed-heartbeat receipt is recorded; current Catalog status is unknown");
  } else {
    try {
      const heartbeatStat = lstatSync(heartbeatPath);
      if (!heartbeatStat.isFile() || heartbeatStat.isSymbolicLink() || (heartbeatStat.mode & 0o077) !== 0) throw new Error("unsafe heartbeat diagnostics");
      const heartbeat = JSON.parse(readFileSync(heartbeatPath, "utf8")) as { outcome?: string; last_success_at?: string; accepted_sessions?: number; last_attempt_at?: string };
      const lastSuccess = typeof heartbeat.last_success_at === "string" ? Date.parse(heartbeat.last_success_at) : Number.NaN;
      const ageSeconds = Number.isFinite(lastSuccess) ? Math.max(0, Math.floor(((input.now ?? (() => new Date()))().getTime() - lastSuccess) / 1000)) : null;
      if (ageSeconds !== null && ageSeconds > 900) {
        add("enrollment_heartbeat", false, `last signed-heartbeat receipt is ${ageSeconds} seconds old; current Catalog status is still unknown`);
      } else if (heartbeat.outcome === "failed") {
        addUnknown("enrollment_heartbeat", ageSeconds === null
          ? "last signed-heartbeat attempt failed and no successful receipt is recorded; current Catalog status is unknown"
          : `last attempt failed; last successful receipt was ${ageSeconds} seconds ago and current Catalog status is unknown`);
      } else if (ageSeconds !== null && ageSeconds <= 900) {
        addUnknown("enrollment_heartbeat", `Catalog accepted a signed heartbeat ${ageSeconds} seconds ago; current binding state remains unverified`);
      } else {
        addUnknown("enrollment_heartbeat", ageSeconds === null
          ? "no successful signed-heartbeat receipt is recorded; current Catalog status is unknown"
          : `last signed-heartbeat receipt is ${ageSeconds} seconds old; current Catalog status is unknown`);
      }
    } catch {
      add("enrollment_heartbeat", false, "local signed-heartbeat diagnostics are malformed or unreadable");
    }
  }
  addUnknown("catalog_binding_online", "live Catalog binding status was not queried; local publication and heartbeat receipts do not prove current online availability");

  if (refsDistinct && storageOk) {
    try {
      const expiry = await inspectMerchantCredentialExpiry({
        baseUrl: process.env.KIWI_COMMERCE_URL ?? profile.commerce.base_url,
        merchantId: profile.agent_id,
        tokenEnv: profile.commerce.token_env,
        credentialsPath,
        ...(input.now !== undefined ? { now: input.now } : {}),
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const detail = expiry.secondsRemaining === null
        ? "authenticated token has no server expiry"
        : `authenticated token expires at ${expiry.expiresAt} (${expiry.secondsRemaining} seconds remaining)`;
      add("protected_token_status", true, detail);
    } catch (error) {
      add("protected_token_status", false, error instanceof Error ? error.message : "protected token status failed");
    }
  } else {
    add("protected_token_status", false, "skipped because credential scope or secure storage is not ready");
  }

  const schedulePath = path.join(runtimeDir, "credential-rotation-schedule.json");
  if (!existsSync(schedulePath)) {
    add("automatic_rotation", false, "no runtime rotation schedule record; start kiwi merchant runtime to enable pre-expiry checks");
  } else {
    try {
      const stat = lstatSync(schedulePath);
      const schedule = JSON.parse(readFileSync(schedulePath, "utf8")) as Record<string, unknown>;
      const pid = Number(schedule.supervisor_pid);
      const sameProcess = Number.isSafeInteger(pid) && (input.processCheck ?? processMatches)(pid);
      const enabled = schedule.enabled === true && schedule.merchant_id === profile.agent_id;
      const interval = Number(schedule.poll_interval_seconds);
      const lastCheck = typeof schedule.last_check_at === "string" ? Date.parse(schedule.last_check_at) : Number.NaN;
      const currentMs = (input.now ?? (() => new Date()))().getTime();
      const fresh = Number.isFinite(lastCheck) && currentMs - lastCheck <= Math.max(interval * 2, 300) * 1000;
      const lastFailed = schedule.last_result === "failed" || schedule.last_error !== undefined;
      const active = stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && enabled && sameProcess && !lastFailed &&
        (schedule.last_check_at === undefined || fresh);
      const disabledReason = typeof schedule.disabled_reason === "string" ? schedule.disabled_reason : "";
      add("automatic_rotation", active, active
        ? `active; checks every ${interval} seconds, rotates ${String(schedule.rotate_before_seconds)} seconds before expiry${schedule.last_result === undefined ? "; first check pending" : `; last result ${String(schedule.last_result)}`}`
        : disabledReason !== "" ? `schedule disabled: ${disabledReason}` : lastFailed ? "last automatic rotation check failed; review the runtime warning and protected token status" : "schedule is stale or its supervisor process cannot be verified");
    } catch {
      add("automatic_rotation", false, "schedule record is unreadable; automatic rotation status is unverified");
    }
  }

  const status = checks.some((check) => check.state === "failed")
    ? "failed"
    : checks.some((check) => check.state === "unknown") ? "unknown" : "ok";
  return { ok: status === "ok", status, merchant_id: profile.agent_id, checks };
}
