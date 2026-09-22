/**
 * Workbench v0.1.1 可信确认与审批仲裁薄切片。
 *
 * 这不是“前端说 WebAuthn 成功”的适配器：服务端解析 clientDataJSON 与
 * authenticatorData，校验 challenge、精确 origin、RP ID hash、UP/UV、签名、凭据归属、
 * 撤销状态和 signCount。确认核销、唯一决定、operation 与 outbox 在同一 SQLite
 * BEGIN IMMEDIATE 原子边界提交。
 *
 * 注册仪式的 attestation/身份恢复仍由上层可信登记流程完成；本存储只接受明确标记为
 * 已验证的注册结果，绝不把普通页面提交的公钥当成已验证认证器。
 */

import {
  createPublicKey,
  createHash,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  webcrypto,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
  type VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { COSEALG, convertCOSEtoPKCS } from "@simplewebauthn/server/helpers";

import { inImmediateTransaction } from "../../merchant-core/storage/transaction.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workbench_webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  sign_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS workbench_webauthn_registrations (
  registration_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS workbench_confirmation_requests (
  confirmation_id TEXT PRIMARY KEY,
  request_ref TEXT UNIQUE NOT NULL,
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  approval_generation INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  operation_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS workbench_approval_decisions (
  merchant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  approval_generation INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  actor_id TEXT NOT NULL,
  confirmation_id TEXT UNIQUE NOT NULL,
  operation_id TEXT UNIQUE NOT NULL,
  action_digest TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, candidate_id, approval_generation)
);
CREATE TABLE IF NOT EXISTS workbench_approval_operations (
  operation_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  approval_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','running','succeeded','failed','unknown')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workbench_approval_outbox (
  merchant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action_step TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','leased','completed','failed')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, operation_id, action_step)
);
`;

export interface WebAuthnAssertionInput {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export interface ConfirmationRequest {
  confirmationId: string;
  requestRef: string;
  challenge: string;
  expiresAt: string;
}

export type DecisionOutcome =
  | { kind: "decided"; decision: "approve" | "reject"; operationId: string }
  | {
      kind: "already_decided";
      decision: "approve" | "reject";
      operationId: string;
      actorId: string;
    };

interface ConfirmationRow {
  confirmation_id: string;
  merchant_id: string;
  actor_id: string;
  candidate_id: string;
  approval_generation: number;
  decision: "approve" | "reject";
  operation_id: string;
  action_digest: string;
  expected_version: number;
  challenge: string;
  expires_at: string;
  consumed_at: string | null;
}

interface CredentialRow {
  credential_id: string;
  merchant_id: string;
  actor_id: string;
  public_key_pem: string;
  rp_id: string;
  origin: string;
  sign_count: number;
  revoked_at: string | null;
}

interface DecisionRow {
  decision: "approve" | "reject";
  operation_id: string;
  actor_id: string;
}

export class WorkbenchConfirmationError extends Error {
  readonly code:
    | "invalid_registration"
    | "confirmation_not_found"
    | "confirmation_expired"
    | "confirmation_consumed"
    | "confirmation_binding_mismatch"
    | "credential_unavailable"
    | "assertion_invalid";

  constructor(code: WorkbenchConfirmationError["code"], message: string) {
    super(message);
    this.name = "WorkbenchConfirmationError";
    this.code = code;
  }
}

export class WorkbenchConfirmationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly registrationVerifier: typeof verifyRegistrationResponse;

  constructor(options: {
    db: DatabaseSync;
    now?: () => string;
    registrationVerifier?: typeof verifyRegistrationResponse;
  }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.registrationVerifier = options.registrationVerifier ?? verifyRegistrationResponse;
    this.db.exec("pragma busy_timeout = 5000");
    this.db.exec(SCHEMA);
    ensureColumn(this.db, "workbench_approval_outbox", "lease_owner", "TEXT");
    ensureColumn(this.db, "workbench_approval_outbox", "lease_expires_at", "TEXT");
    ensureColumn(this.db, "workbench_approval_outbox", "attempts", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(
      this.db,
      "workbench_confirmation_requests",
      "snapshot_json",
      "TEXT NOT NULL DEFAULT '{}'",
    );
  }

  async beginCredentialRegistration(input: {
    merchantId: string;
    actorId: string;
    rpName: string;
    rpId: string;
    origin: string;
    userName: string;
    userDisplayName: string;
  }): Promise<{
    registration_id: string;
    expires_at: string;
    options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
  }> {
    const merchantId = requireText(input.merchantId, "merchantId");
    const actorId = requireText(input.actorId, "actorId");
    const rpId = requireText(input.rpId, "rpId");
    const origin = requireHttpsOrigin(input.origin);
    if (new URL(origin).hostname !== rpId && !new URL(origin).hostname.endsWith(`.${rpId}`)) {
      throw new WorkbenchConfirmationError(
        "invalid_registration",
        "registration origin is outside the RP ID",
      );
    }
    const challenge = randomBytes(32).toString("base64url");
    const registrationId = `wrg_${randomBytes(18).toString("base64url")}`;
    const stamp = this.now();
    const expiresAt = new Date(Date.parse(stamp) + 5 * 60 * 1000).toISOString();
    const existing = this.db
      .prepare(
        `SELECT credential_id FROM workbench_webauthn_credentials
         WHERE merchant_id=? AND actor_id=? AND revoked_at IS NULL ORDER BY credential_id`,
      )
      .all(merchantId, actorId) as Array<{ credential_id: string }>;
    const options = await generateRegistrationOptions({
      rpName: requireText(input.rpName, "rpName"),
      rpID: rpId,
      userName: requireText(input.userName, "userName"),
      userDisplayName: requireText(input.userDisplayName, "userDisplayName"),
      userID: createHash("sha256").update(`${merchantId}\0${actorId}`).digest(),
      challenge,
      timeout: 5 * 60 * 1000,
      attestationType: "none",
      excludeCredentials: existing.map((credential) => ({ id: credential.credential_id })),
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "preferred",
      },
      supportedAlgorithmIDs: [COSEALG.ES256],
    });
    this.db
      .prepare(
        `INSERT INTO workbench_webauthn_registrations
         (registration_id, merchant_id, actor_id, challenge, rp_id, origin,
          expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(registrationId, merchantId, actorId, challenge, rpId, origin, expiresAt, stamp);
    return { registration_id: registrationId, expires_at: expiresAt, options };
  }

  async finishCredentialRegistration(input: {
    registrationId: string;
    merchantId: string;
    actorId: string;
    response: RegistrationResponseJSON;
  }): Promise<{ credential_id: string }> {
    const row = this.db
      .prepare("SELECT * FROM workbench_webauthn_registrations WHERE registration_id=?")
      .get(input.registrationId) as unknown as
      | {
          merchant_id: string;
          actor_id: string;
          challenge: string;
          rp_id: string;
          origin: string;
          expires_at: string;
          used_at: string | null;
        }
      | undefined;
    if (
      row === undefined ||
      row.merchant_id !== input.merchantId ||
      row.actor_id !== input.actorId ||
      row.used_at !== null
    ) {
      throw new WorkbenchConfirmationError("invalid_registration", "registration is missing, used or misbound");
    }
    if (Date.parse(row.expires_at) <= Date.parse(this.now())) {
      throw new WorkbenchConfirmationError("invalid_registration", "registration challenge expired");
    }
    let verified: VerifiedRegistrationResponse;
    try {
      verified = await this.registrationVerifier({
        response: input.response,
        expectedChallenge: row.challenge,
        expectedOrigin: row.origin,
        expectedRPID: row.rp_id,
        expectedType: "webauthn.create",
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: [COSEALG.ES256],
      });
    } catch {
      throw new WorkbenchConfirmationError("invalid_registration", "WebAuthn attestation verification failed");
    }
    if (!verified.verified || !verified.registrationInfo.userVerified) {
      throw new WorkbenchConfirmationError("invalid_registration", "WebAuthn registration was not UV verified");
    }
    const rawPublicKey = convertCOSEtoPKCS(verified.registrationInfo.credential.publicKey);
    const cryptoKey = await webcrypto.subtle.importKey(
      "raw",
      rawPublicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", cryptoKey));
    const publicKeyPem = createPublicKey({ key: spki, format: "der", type: "spki" })
      .export({ format: "pem", type: "spki" })
      .toString();

    return inImmediateTransaction(this.db, () => {
      const consumed = this.db
        .prepare(
          `UPDATE workbench_webauthn_registrations SET used_at=?
           WHERE registration_id=? AND used_at IS NULL AND expires_at>?`,
        )
        .run(this.now(), input.registrationId, this.now());
      if (consumed.changes !== 1) {
        throw new WorkbenchConfirmationError("invalid_registration", "registration was consumed concurrently");
      }
      this.persistVerifiedCredential({
        registrationVerified: true,
        credentialId: verified.registrationInfo.credential.id,
        merchantId: input.merchantId,
        actorId: input.actorId,
        publicKeyPem,
        rpId: row.rp_id,
        origin: row.origin,
        signCount: verified.registrationInfo.credential.counter,
      });
      return { credential_id: verified.registrationInfo.credential.id };
    });
  }

  persistVerifiedCredential(input: {
    registrationVerified: true;
    credentialId: string;
    merchantId: string;
    actorId: string;
    publicKeyPem: string;
    rpId: string;
    origin: string;
    signCount?: number;
  }): void {
    if (input.registrationVerified !== true) {
      throw new WorkbenchConfirmationError("invalid_registration", "credential registration was not verified");
    }
    this.db
      .prepare(
        `INSERT INTO workbench_webauthn_credentials
         (credential_id, merchant_id, actor_id, public_key_pem, rp_id, origin, sign_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requireText(input.credentialId, "credentialId"),
        requireText(input.merchantId, "merchantId"),
        requireText(input.actorId, "actorId"),
        requireText(input.publicKeyPem, "publicKeyPem"),
        requireText(input.rpId, "rpId"),
        requireHttpsOrigin(input.origin),
        input.signCount ?? 0,
        this.now(),
      );
  }

  revokeCredential(credentialId: string, merchantId: string, actorId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE workbench_webauthn_credentials SET revoked_at = ?
         WHERE credential_id = ? AND merchant_id = ? AND actor_id = ? AND revoked_at IS NULL`,
      )
      .run(this.now(), credentialId, merchantId, actorId);
    return result.changes === 1;
  }

  hasUsableCredential(merchantId: string, actorId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 present FROM workbench_webauthn_credentials
         WHERE merchant_id=? AND actor_id=? AND revoked_at IS NULL LIMIT 1`,
      )
      .get(merchantId, actorId) as { present: number } | undefined;
    return row?.present === 1;
  }

  verifyCommittedDecision(input: {
    operationId: string;
    candidateId: string;
    actorId: string;
    decision: "approve" | "reject";
    actionDigest: string;
  }): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 matched FROM workbench_approval_decisions
         WHERE operation_id=? AND candidate_id=? AND actor_id=? AND decision=? AND action_digest=?`,
      )
      .get(
        input.operationId,
        input.candidateId,
        input.actorId,
        input.decision,
        input.actionDigest,
      ) as { matched: number } | undefined;
    return row?.matched === 1;
  }

  authorizationSnapshotForOperation(operationId: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare(
        `SELECT r.snapshot_json FROM workbench_approval_decisions d
         JOIN workbench_confirmation_requests r ON r.confirmation_id=d.confirmation_id
         WHERE d.operation_id=?`,
      )
      .get(operationId) as { snapshot_json: string } | undefined;
    if (row === undefined) return undefined;
    const snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    const authorization = snapshot["decision_authorization"];
    return authorization !== null && typeof authorization === "object" && !Array.isArray(authorization)
      ? (authorization as Record<string, unknown>)
      : undefined;
  }

  createRequest(input: {
    merchantId: string;
    actorId: string;
    candidateId: string;
    approvalGeneration: number;
    decision: "approve" | "reject";
    operationId: string;
    actionDigest: string;
    actionSnapshot: Readonly<Record<string, unknown>>;
    expectedVersion: number;
    expiresAt: string;
  }): ConfirmationRequest {
    const nowMs = Date.parse(this.now());
    const expiresMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs || expiresMs > nowMs + 5 * 60 * 1000) {
      throw new WorkbenchConfirmationError(
        "confirmation_expired",
        "confirmation expiry must be in the next five minutes",
      );
    }
    if (!Number.isInteger(input.approvalGeneration) || input.approvalGeneration < 1) {
      throw new Error("approvalGeneration must be a positive integer");
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Error("expectedVersion must be a non-negative integer");
    }
    const confirmationId = `wcf_${randomBytes(18).toString("base64url")}`;
    const requestRef = `wcr_${randomBytes(32).toString("base64url")}`;
    const challenge = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        `INSERT INTO workbench_confirmation_requests
         (confirmation_id, request_ref, merchant_id, actor_id, candidate_id, approval_generation,
          decision, operation_id, action_digest, snapshot_json, expected_version, challenge,
          expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        confirmationId,
        requestRef,
        requireText(input.merchantId, "merchantId"),
        requireText(input.actorId, "actorId"),
        requireText(input.candidateId, "candidateId"),
        input.approvalGeneration,
        input.decision,
        requireText(input.operationId, "operationId"),
        requireSha256(input.actionDigest),
        JSON.stringify(input.actionSnapshot),
        input.expectedVersion,
        challenge,
        input.expiresAt,
        this.now(),
      );
    return { confirmationId, requestRef, challenge, expiresAt: input.expiresAt };
  }

  requestProjection(input: {
    confirmationId: string;
    merchantId: string;
    actorId: string;
  }): {
    confirmation_id: string;
    candidate_id: string;
    decision: "approve" | "reject";
    operation_id: string;
    expected_version: number;
    snapshot: Record<string, unknown>;
    expires_at: string;
  } {
    const row = this.requireRequest(input.confirmationId);
    if (row.merchant_id !== input.merchantId || row.actor_id !== input.actorId) {
      throw new WorkbenchConfirmationError(
        "confirmation_binding_mismatch",
        "confirmation belongs to another merchant or actor",
      );
    }
    const snapshotRow = this.db
      .prepare("SELECT snapshot_json FROM workbench_confirmation_requests WHERE confirmation_id=?")
      .get(input.confirmationId) as { snapshot_json: string };
    return {
      confirmation_id: row.confirmation_id,
      candidate_id: row.candidate_id,
      decision: row.decision,
      operation_id: row.operation_id,
      expected_version: row.expected_version,
      snapshot: JSON.parse(snapshotRow.snapshot_json) as Record<string, unknown>,
      expires_at: row.expires_at,
    };
  }

  requestProjectionByRef(input: {
    requestRef: string;
    merchantId: string;
    actorId: string;
  }): ReturnType<WorkbenchConfirmationStore["requestProjection"]> {
    const row = this.db
      .prepare(
        `SELECT confirmation_id FROM workbench_confirmation_requests
         WHERE request_ref=? AND merchant_id=? AND actor_id=?`,
      )
      .get(input.requestRef, input.merchantId, input.actorId) as
      | { confirmation_id: string }
      | undefined;
    if (row === undefined) {
      throw new WorkbenchConfirmationError(
        "confirmation_not_found",
        "unknown confirmation request reference",
      );
    }
    return this.requestProjection({
      confirmationId: row.confirmation_id,
      merchantId: input.merchantId,
      actorId: input.actorId,
    });
  }

  assertionOptions(input: {
    confirmationId: string;
    merchantId: string;
    actorId: string;
  }): {
    challenge: string;
    rp_id: string;
    allow_credentials: Array<{ id: string; type: "public-key" }>;
    user_verification: "required";
    expires_at: string;
  } {
    const row = this.requireRequest(input.confirmationId);
    if (row.merchant_id !== input.merchantId || row.actor_id !== input.actorId) {
      throw new WorkbenchConfirmationError(
        "confirmation_binding_mismatch",
        "confirmation belongs to another merchant or actor",
      );
    }
    const credentials = this.db
      .prepare(
        `SELECT credential_id, rp_id FROM workbench_webauthn_credentials
         WHERE merchant_id=? AND actor_id=? AND revoked_at IS NULL ORDER BY credential_id`,
      )
      .all(input.merchantId, input.actorId) as Array<{ credential_id: string; rp_id: string }>;
    if (credentials.length === 0) {
      throw new WorkbenchConfirmationError(
        "credential_unavailable",
        "actor has no verified, non-revoked WebAuthn credential",
      );
    }
    const rpId = credentials[0]!.rp_id;
    if (credentials.some((credential) => credential.rp_id !== rpId)) {
      throw new WorkbenchConfirmationError(
        "credential_unavailable",
        "actor credentials do not share the confirmation RP ID",
      );
    }
    return {
      challenge: row.challenge,
      rp_id: rpId,
      allow_credentials: credentials.map((credential) => ({
        id: credential.credential_id,
        type: "public-key" as const,
      })),
      user_verification: "required",
      expires_at: row.expires_at,
    };
  }

  finalizeDecision(input: {
    confirmationId: string;
    merchantId: string;
    actorId: string;
    candidateId: string;
    approvalGeneration: number;
    decision: "approve" | "reject";
    actionDigest: string;
    expectedVersion: number;
    assertion: WebAuthnAssertionInput;
  }): DecisionOutcome {
    const request = this.requireRequest(input.confirmationId);
    assertRequestBinding(request, input);
    const credential = this.requireCredential(
      input.assertion.credentialId,
      input.merchantId,
      input.actorId,
    );
    const nextSignCount = verifyAssertion(request, credential, input.assertion, this.now());

    try {
      return inImmediateTransaction(this.db, (): DecisionOutcome => {
        const freshRequest = this.requireRequest(input.confirmationId);
        assertRequestBinding(freshRequest, input);
        const freshCredential = this.requireCredential(
          input.assertion.credentialId,
          input.merchantId,
          input.actorId,
        );
        if (freshCredential.sign_count !== credential.sign_count) {
          throw new WorkbenchConfirmationError("assertion_invalid", "credential counter changed");
        }
        const existing = this.readDecision(
          input.merchantId,
          input.candidateId,
          input.approvalGeneration,
        );
        if (existing !== undefined) {
          // 已决定早退：此刻只有只读语句，fn 内 return 由 wrapper 提交空事务——
          // 与原 rollback 完全等价（零持久效果），且不经下方 catch 的 winner 重查。
          return {
            kind: "already_decided",
            decision: existing.decision,
            operationId: existing.operation_id,
            actorId: existing.actor_id,
          };
        }
        const stamp = this.now();
        this.db
          .prepare(
            `UPDATE workbench_webauthn_credentials SET sign_count = ?
             WHERE credential_id = ? AND sign_count = ? AND revoked_at IS NULL`,
          )
          .run(nextSignCount, freshCredential.credential_id, freshCredential.sign_count);
        const consumed = this.db
          .prepare(
            `UPDATE workbench_confirmation_requests SET consumed_at = ?
             WHERE confirmation_id = ? AND consumed_at IS NULL AND expires_at > ?`,
          )
          .run(stamp, freshRequest.confirmation_id, stamp);
        if (consumed.changes !== 1) {
          throw new WorkbenchConfirmationError("confirmation_consumed", "confirmation was already consumed");
        }
        this.db
          .prepare(
            `INSERT INTO workbench_approval_decisions
             (merchant_id, candidate_id, approval_generation, decision, actor_id, confirmation_id,
              operation_id, action_digest, decided_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.merchantId,
            input.candidateId,
            input.approvalGeneration,
            input.decision,
            input.actorId,
            freshRequest.confirmation_id,
            freshRequest.operation_id,
            input.actionDigest,
            stamp,
          );
        this.db
          .prepare(
            `INSERT INTO workbench_approval_operations
             (operation_id, merchant_id, candidate_id, approval_generation, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'accepted', ?, ?)`,
          )
          .run(
            freshRequest.operation_id,
            input.merchantId,
            input.candidateId,
            input.approvalGeneration,
            stamp,
            stamp,
          );
        this.db
          .prepare(
            `INSERT INTO workbench_approval_outbox
             (merchant_id, operation_id, action_step, fencing_token, status, created_at)
             VALUES (?, ?, 'execute-approved-candidate', 0, 'pending', ?)`,
          )
          .run(input.merchantId, freshRequest.operation_id, stamp);
        return { kind: "decided", decision: input.decision, operationId: freshRequest.operation_id };
      });
    } catch (error) {
      // 并发败者补偿（原手写 catch 语义逐字保留）：wrapper 已回滚，这里重查
      // 是否已有 winner 先落地——有则按 already_decided 正常返回，否则原样抛出。
      const winner = this.readDecision(
        input.merchantId,
        input.candidateId,
        input.approvalGeneration,
      );
      if (winner !== undefined) {
        return {
          kind: "already_decided",
          decision: winner.decision,
          operationId: winner.operation_id,
          actorId: winner.actor_id,
        };
      }
      throw error;
    }
  }

  private requireRequest(confirmationId: string): ConfirmationRow {
    const row = this.db
      .prepare("SELECT * FROM workbench_confirmation_requests WHERE confirmation_id = ?")
      .get(confirmationId) as unknown as ConfirmationRow | undefined;
    if (row === undefined) {
      throw new WorkbenchConfirmationError("confirmation_not_found", "unknown confirmation request");
    }
    if (row.consumed_at !== null) {
      throw new WorkbenchConfirmationError("confirmation_consumed", "confirmation was already consumed");
    }
    if (Date.parse(row.expires_at) <= Date.parse(this.now())) {
      throw new WorkbenchConfirmationError("confirmation_expired", "confirmation has expired");
    }
    return row;
  }

  private requireCredential(credentialId: string, merchantId: string, actorId: string): CredentialRow {
    const row = this.db
      .prepare(
        `SELECT * FROM workbench_webauthn_credentials
         WHERE credential_id = ? AND merchant_id = ? AND actor_id = ? AND revoked_at IS NULL`,
      )
      .get(credentialId, merchantId, actorId) as unknown as CredentialRow | undefined;
    if (row === undefined) {
      throw new WorkbenchConfirmationError("credential_unavailable", "credential is missing, revoked or belongs to another actor");
    }
    return row;
  }

  private readDecision(
    merchantId: string,
    candidateId: string,
    approvalGeneration: number,
  ): DecisionRow | undefined {
    return this.db
      .prepare(
        `SELECT decision, operation_id, actor_id FROM workbench_approval_decisions
         WHERE merchant_id = ? AND candidate_id = ? AND approval_generation = ?`,
      )
      .get(merchantId, candidateId, approvalGeneration) as unknown as DecisionRow | undefined;
  }
}

function assertRequestBinding(
  request: ConfirmationRow,
  input: {
    merchantId: string;
    actorId: string;
    candidateId: string;
    approvalGeneration: number;
    decision: "approve" | "reject";
    actionDigest: string;
    expectedVersion: number;
  },
): void {
  if (
    request.merchant_id !== input.merchantId ||
    request.actor_id !== input.actorId ||
    request.candidate_id !== input.candidateId ||
    request.approval_generation !== input.approvalGeneration ||
    request.decision !== input.decision ||
    request.action_digest !== input.actionDigest ||
    request.expected_version !== input.expectedVersion
  ) {
    throw new WorkbenchConfirmationError(
      "confirmation_binding_mismatch",
      "confirmation does not match the actor, action snapshot or object version",
    );
  }
}

function verifyAssertion(
  request: ConfirmationRow,
  credential: CredentialRow,
  assertion: WebAuthnAssertionInput,
  now: string,
): number {
  if (Date.parse(request.expires_at) <= Date.parse(now)) {
    throw new WorkbenchConfirmationError("confirmation_expired", "confirmation has expired");
  }
  let clientData: Buffer;
  let authenticatorData: Buffer;
  let signature: Buffer;
  let client: Record<string, unknown>;
  try {
    clientData = Buffer.from(assertion.clientDataJSON, "base64url");
    authenticatorData = Buffer.from(assertion.authenticatorData, "base64url");
    signature = Buffer.from(assertion.signature, "base64url");
    client = JSON.parse(clientData.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new WorkbenchConfirmationError("assertion_invalid", "assertion encoding is invalid");
  }
  if (
    client["type"] !== "webauthn.get" ||
    client["challenge"] !== request.challenge ||
    client["origin"] !== credential.origin ||
    client["crossOrigin"] === true
  ) {
    throw new WorkbenchConfirmationError("assertion_invalid", "client data binding is invalid");
  }
  if (authenticatorData.length < 37) {
    throw new WorkbenchConfirmationError("assertion_invalid", "authenticator data is too short");
  }
  const expectedRpHash = createHash("sha256").update(credential.rp_id).digest();
  if (!timingSafeEqual(authenticatorData.subarray(0, 32), expectedRpHash)) {
    throw new WorkbenchConfirmationError("assertion_invalid", "RP ID hash mismatch");
  }
  const flags = authenticatorData[32] ?? 0;
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) {
    throw new WorkbenchConfirmationError("assertion_invalid", "user presence and verification are required");
  }
  const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientData).digest()]);
  if (!verifySignature("sha256", signed, credential.public_key_pem, signature)) {
    throw new WorkbenchConfirmationError("assertion_invalid", "assertion signature is invalid");
  }
  const nextSignCount = authenticatorData.readUInt32BE(33);
  if (nextSignCount !== 0 && nextSignCount <= credential.sign_count) {
    throw new WorkbenchConfirmationError("assertion_invalid", "credential counter did not advance");
  }
  return nextSignCount;
}

function requireText(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (text === "") throw new Error(`${field} must be non-empty`);
  return text;
}

function requireSha256(value: string): string {
  const text = requireText(value, "actionDigest");
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new Error("actionDigest must be sha256:<64 lowercase hex>");
  return text;
}

function requireHttpsOrigin(value: string): string {
  const text = requireText(value, "origin");
  const url = new URL(text);
  if (url.protocol !== "https:" || url.origin !== text || url.pathname !== "/") {
    throw new Error("origin must be an exact HTTPS origin without path, query or fragment");
  }
  return text;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, declaration: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}
