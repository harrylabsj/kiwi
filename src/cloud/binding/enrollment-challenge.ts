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

/** 独立 Runtime 的 enrollment 挑战应答。只响应本机已授权会话和本机持钥挑战。 */
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { withEnrollmentStoreLock } from "./store-lock.js";
import { writeFileAtomic } from "../../fs/atomic-write.js";
import type { JwsSigningIdentity } from "../../trust/identity/jws.js";
import { signCompactJws } from "../../trust/identity/jws.js";
import { publicKeyThumbprint } from "../../trust/binding/thumbprint.js";

export interface AuthorizedEnrollment {
  store_revision?: number;
  enrollment_id: string;
  runtime_origin: string;
  key_thumbprint: string;
  expires_at: string;
  status:
    | "preparing"
    | "authorized"
    | "bound"
    | "published"
    | "replaced"
    | "revoked"
    | "paused"
    | "expired"
    | "canceled";
}

export interface EnrollmentChallengeStore {
  version: 1;
  sessions: AuthorizedEnrollment[];
  consumed: string[];
}

const STORE_FILE = "merchant-enrollments.json";
const MAX_BODY = 16 * 1024;
const MAX_CONSUMED = 4096;
const MAX_PER_MINUTE = 30;

export function enrollmentStorePath(dataDir: string): string {
  return path.join(dataDir, STORE_FILE);
}

export function readEnrollmentStore(dataDir: string): EnrollmentChallengeStore {
  const file = enrollmentStorePath(dataDir);
  if (!existsSync(file)) return { version: 1, sessions: [], consumed: [] };
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<EnrollmentChallengeStore>;
  if (value.version !== 1 || !Array.isArray(value.sessions) || !Array.isArray(value.consumed)) {
    throw new Error("merchant enrollment 状态文件格式错误，已 fail-closed");
  }
  return value as EnrollmentChallengeStore;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** 每次请求重新读 0600 文件，因此 CLI 退出后仍能响应 Catalog 的公网探测。 */
export function createEnrollmentChallengeResponder(input: {
  dataDir: string;
  signingIdentity: JwsSigningIdentity;
  now?: () => Date;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const now = input.now ?? (() => new Date());
  const requestTimes: number[] = [];
  const ownThumbprint = publicKeyThumbprint(
    createPublicKey(input.signingIdentity.privateKey).export({
      type: "spki",
      format: "pem",
    }) as string,
  );
  return (req, res) => {
    void (async () => {
      if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
      if (req.url?.split("?", 1)[0] !== "/.well-known/kiwi-binding-challenge")
        return json(res, 404, { error: "not_found" });
      const currentTime = now().getTime();
      while (requestTimes.length > 0 && currentTime - (requestTimes[0] ?? currentTime) > 60_000)
        requestTimes.shift();
      if (requestTimes.length >= MAX_PER_MINUTE) return json(res, 429, { error: "rate_limited" });
      requestTimes.push(currentTime);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY) return json(res, 413, { error: "request_too_large" });
        chunks.push(buffer);
      }
      let request: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("shape");
        request = parsed as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: "invalid_request" });
      }
      const expectedKeys = [
        "audience",
        "challenge",
        "enrollment_id",
        "expires_at",
        "issued_at",
        "key_thumbprint",
        "origin",
      ];
      if (Object.keys(request).sort().join(",") !== expectedKeys.sort().join(","))
        return json(res, 400, { error: "invalid_challenge_fields" });
      const enrollmentId = request["enrollment_id"];
      if (
        typeof enrollmentId !== "string" ||
        enrollmentId.length < 1 ||
        enrollmentId.length > 64 ||
        request["audience"] !== "kiwi-catalog" ||
        typeof request["challenge"] !== "string" ||
        !/^[A-Za-z0-9_-]{40,64}$/.test(request["challenge"]) ||
        typeof request["origin"] !== "string" ||
        request["origin"].length > 2048 ||
        typeof request["key_thumbprint"] !== "string" ||
        request["key_thumbprint"].length > 80 ||
        typeof request["issued_at"] !== "string" ||
        typeof request["expires_at"] !== "string"
      ) {
        return json(res, 400, { error: "invalid_challenge_shape" });
      }
      const issuedMs = Date.parse(request["issued_at"]);
      const expiresMs = Date.parse(request["expires_at"]);
      if (
        !Number.isFinite(issuedMs) ||
        !Number.isFinite(expiresMs) ||
        expiresMs - issuedMs !== 60_000 ||
        issuedMs > now().getTime() + 30_000 ||
        expiresMs <= now().getTime()
      )
        return json(res, 400, { error: "invalid_challenge_time" });
      const store = readEnrollmentStore(input.dataDir);
      const liveConsumed = store.consumed.filter((item) => {
        const separator = item.lastIndexOf(":");
        if (separator < 0) return true; // 历史哈希永不过期：保守防重放。
        const expires = Number(item.slice(separator + 1));
        return !Number.isFinite(expires) || expires > currentTime;
      });
      const session = store.sessions.find((s) => s.enrollment_id === enrollmentId);
      if (session === undefined || !["authorized", "bound"].includes(session.status)) {
        return json(res, 403, { error: "enrollment_not_authorized" });
      }
      if (
        session.key_thumbprint !== ownThumbprint ||
        request["key_thumbprint"] !== ownThumbprint ||
        request["origin"] !== session.runtime_origin ||
        !Number.isFinite(Date.parse(session.expires_at)) ||
        Date.parse(session.expires_at) <= now().getTime()
      ) {
        return json(res, 403, { error: "challenge_mismatch" });
      }
      const challenge = request["challenge"] as string;
      const digest = createHash("sha256").update(`${enrollmentId}:${challenge}`).digest("hex");
      if (liveConsumed.some((item) => item.startsWith(`${digest}:`) || item === digest))
        return json(res, 409, { error: "challenge_replayed" });
      if (liveConsumed.length >= MAX_CONSUMED)
        return json(res, 503, { error: "challenge_store_full" });
      const unsigned = {
        enrollment_id: enrollmentId,
        challenge,
        origin: request["origin"],
        key_thumbprint: ownThumbprint,
        audience: "kiwi-catalog",
        issued_at: request["issued_at"],
        expires_at: request["expires_at"],
      };
      const keyId = input.signingIdentity.keyid;
      const nonce = randomBytes(24).toString("base64url");
      const proofJws = signCompactJws(
        { ...unsigned, key_id: keyId, nonce, purpose: "kiwi-binding-challenge" },
        input.signingIdentity,
        {
          extraHeader: { typ: "kiwi-enrollment-challenge" },
        },
      );
      // Recheck and consume atomically in the state file before returning a signature.
      try {
        withEnrollmentStoreLock(input.dataDir, () => {
          const fresh = readEnrollmentStore(input.dataDir);
          const current = fresh.sessions.find((s) => s.enrollment_id === enrollmentId);
          if (
            !current ||
            !["authorized", "bound"].includes(current.status) ||
            current.key_thumbprint !== ownThumbprint ||
            current.runtime_origin !== request["origin"] ||
            Date.parse(current.expires_at) <= now().getTime()
          )
            throw new Error("challenge_mismatch");
          const freshConsumed = fresh.consumed.filter((item) => {
            const separator = item.lastIndexOf(":");
            if (separator < 0) return true;
            const expires = Number(item.slice(separator + 1));
            return !Number.isFinite(expires) || expires > currentTime;
          });
          if (freshConsumed.some((item) => item.startsWith(`${digest}:`) || item === digest))
            throw new Error("challenge_replayed");
          if (freshConsumed.length >= MAX_CONSUMED) throw new Error("challenge_store_full");
          const updated = { ...fresh, consumed: [...freshConsumed, `${digest}:${expiresMs}`] };
          writeFileAtomic(enrollmentStorePath(input.dataDir), `${JSON.stringify(updated)}\n`, {
            mode: 0o600,
          });
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "internal_error";
        return json(res, code === "challenge_replayed" ? 409 : 503, {
          error: ["challenge_replayed", "challenge_store_full", "challenge_mismatch"].includes(code)
            ? code
            : "challenge_store_busy",
        });
      }
      return json(res, 200, { ...unsigned, key_id: keyId, signature: proofJws });
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
    });
  };
}
