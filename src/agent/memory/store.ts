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
 * MemoryStore (design §8–§10): the governed read/write path over the
 * per-agent SQLite memory database.
 *
 * Write governance (§10.1):
 * - explicit user statement ("记住…", not a Restricted inference) =>
 *   active + confirmed, confidence 1.0;
 * - a single observed/inferred signal => candidate (never a hard filter);
 * - >= 3 deduplicated supporting evidences => soft preference activates;
 * - inferred/observed can never write the `constraint` namespace;
 * - Restricted values live only in the Vault, require an explicit source
 *   and a configured data key — otherwise fail closed;
 * - conflicts never silently overwrite: a recent explicit statement
 *   supersedes; anything weaker appends contradict evidence to the
 *   existing item.
 *
 * Read path (§10.3): deterministic score =
 * relevance × scope match × confidence × freshness × source weight
 * (× needs_review penalty). deleted/superseded/expired are never
 * returned; every returned item is written to the retrieval log with the
 * redaction level it was served at. Restricted values never leave the
 * store (metadata_only).
 */

import type { DatabaseSync } from "node:sqlite";
import { uuidv7 } from "@earendil-works/pi-ai";
import type {
  EvidenceSourceType,
  MemoryEventRecord,
  MemoryEventType,
  MemoryItem,
  MemoryNamespace,
  MemoryScope,
  MemorySensitivity,
  MemorySourceKind,
  MemoryStatus,
  Principal,
  RedactionLevel,
  RetrievalLogEntry,
  RetrievalPurpose,
  RetrievedMemory,
  VaultKind,
} from "./types.js";
import {
  isMemoryNamespace,
  isMemorySensitivity,
  isMemorySourceKind,
  isRetrievalPurpose,
  isVaultKind,
  MemoryError,
  parseMemoryScope,
} from "./types.js";
import type { PrivateVault } from "./vault.js";
import { VaultKeyError } from "./vault.js";
import { MEMORY_SCHEMA_VERSION } from "./schema.js";

const SOURCE_WEIGHT: Record<MemorySourceKind, number> = {
  explicit: 1.0,
  observed: 0.8,
  inferred: 0.6,
  imported: 0.7,
};

const DEFAULT_CONFIDENCE: Record<MemorySourceKind, number> = {
  explicit: 1.0,
  observed: 0.5,
  inferred: 0.3,
  imported: 0.6,
};

/** Soft namespaces that repeated behavior may activate without confirmation. */
const SOFT_ACTIVATABLE: ReadonlySet<MemoryNamespace> = new Set(["preference", "routine"]);
const AUTO_ACTIVATE_EVIDENCE = 3;
const MAX_LIMIT = 32;

/**
 * High-impact memories must never be auto-activated by a model `remember`
 * call: a hard `constraint` and any `restricted` value stay `candidate` until
 * the human confirms via `/confirm` (design §10.1/§16). The model asserting
 * `explicit_user_statement` is not ground truth — only a human can promote.
 */
function requiresHumanConfirm(input: RememberInput): boolean {
  return input.namespace === "constraint" || input.sensitivity === "restricted";
}

/**
 * Restricted writes: never let the plaintext echo into evidence summaries or
 * audit reasons (design §6.3 minimal disclosure). The whole-DB plaintext-free
 * guarantee only holds if the model-supplied summary is scrubbed too.
 */
function evidenceSummaryFor(input: RememberInput, summary: string): string {
  if (input.sensitivity !== "restricted" || input.restricted === undefined) return summary;
  const plaintext = input.restricted.plaintext;
  const scrubbed = plaintext !== "" ? summary.split(plaintext).join("…") : summary;
  return scrubbed.trim() !== "" ? scrubbed : "用户确认的敏感信息（已加密保存）";
}

/**
 * Precise personal data must live in the Vault regardless of the sensitivity
 * the model happened to claim (design §6.3, §17). A string value that clearly
 * matches one of these patterns is escalated to `restricted`; if that then
 * fails the Restricted validation (no explicit statement, no data key) the
 * write is refused — never degraded to plaintext.
 */
const PRECISE_PERSONAL_PATTERNS: ReadonlyArray<{ kind: VaultKind; pattern: RegExp }> = [
  {
    kind: "address",
    pattern:
      /(住址|地址|收货|寄到|家庭住址|住在|家住)[^，。；;]{0,20}\d|(?:省|市|区|县|镇|街道).{0,12}(?:号|路|小区|巷)[\d一二三四五六七八九十]*/,
  },
  { kind: "contact", pattern: /(电话|手机|手机号|微信号|联系方式|邮箱|e-?mail|QQ)\s*[:：]?[\s-]*\d{5,}/i },
  { kind: "private_budget", pattern: /(预算|心理价|心理价位|最高出价|上限价)\s*[:：]?\s*(\d+)/ },
  { kind: "merchant_cost", pattern: /(成本|进价)\s*[:：]?\s*(\d+)/ },
  { kind: "merchant_floor", pattern: /(底价|最低价|最低售价)\s*[:：]?\s*(\d+)/ },
  { kind: "other", pattern: /(身份证|银行卡|银行账号|护照|护照号|卡号|账号)\s*[:：]?[\dXx]/i },
];

function classifyPersonalData(value: string): VaultKind | undefined {
  for (const { kind, pattern } of PRECISE_PERSONAL_PATTERNS) {
    if (pattern.test(value)) return kind;
  }
  return undefined;
}

/**
 * Escalate a string value that clearly is precise personal data to a
 * Restricted (Vault) write. Object/array values are left alone — a structured
 * value is the model's explicit non-Restricted choice, not a raw secret.
 */
function escalateSensitivity(input: RememberInput): RememberInput {
  if (input.sensitivity === "restricted") return input;
  if (input.value === undefined || typeof input.value !== "string") return input;
  const kind = classifyPersonalData(input.value);
  if (kind === undefined) return input;
  return {
    ...input,
    sensitivity: "restricted",
    restricted: { kind, plaintext: input.value },
    value: undefined,
  };
}

export interface EvidenceInput {
  source_type: EvidenceSourceType;
  /** Task/session/event reference; dedup key (same-task repeats don't count). */
  source_ref: string;
  summary: string;
  weight?: number;
  observed_at?: string;
}

export interface RememberInput {
  namespace: MemoryNamespace;
  key: string;
  /** Non-Restricted structured value. Mutually exclusive with `restricted`. */
  value?: unknown;
  /** Restricted plaintext, sealed into the Vault. Mutually exclusive with `value`. */
  restricted?: { kind: VaultKind; plaintext: string };
  scope?: MemoryScope;
  source_kind: MemorySourceKind;
  confidence?: number;
  sensitivity: MemorySensitivity;
  expires_at?: string;
  evidence: EvidenceInput;
  /** The user actually stated this (vs. the model inferred it from behavior). */
  explicit_user_statement: boolean;
  actor: string;
}

export type RememberOutcome =
  | { kind: "active"; memory: MemoryItem }
  | { kind: "candidate"; memory: MemoryItem }
  | { kind: "merged"; memory: MemoryItem; evidence_added: boolean }
  | { kind: "conflict"; existing: MemoryItem; evidence_added: boolean };

export interface RetrieveQuery {
  session_id: string;
  task_id?: string;
  purpose: RetrievalPurpose;
  /** User/task text for deterministic relevance matching. */
  text?: string;
  /** Task scopes for scope matching (empty/absent = global query). */
  scopes?: MemoryScope[];
  limit?: number;
  namespaces?: MemoryNamespace[];
}

interface ItemRow {
  memory_id: string;
  principal_id: string;
  namespace: string;
  key: string;
  value_json: string | null;
  vault_ref: string | null;
  scope_json: string;
  source_kind: string;
  confidence: number;
  sensitivity: string;
  status: string;
  confirmed_at: string | null;
  valid_from: string | null;
  expires_at: string | null;
  last_observed_at: string | null;
  evidence_count: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function optText(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

function assertJsonValue(value: unknown, at: string): void {
  if (value === undefined) return;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new MemoryError("validation", `${at}: NaN/Infinity are not storable`);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJsonValue(value[i], `${at}[${i}]`);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(v, `${at}.${k}`);
    }
    return;
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) {
    throw new MemoryError("validation", `${at}: unsupported value type`);
  }
}

/** Redacted snapshot of an item for audit events — never Restricted plaintext. */
function auditSnapshot(item: MemoryItem): Record<string, unknown> {
  return {
    memory_id: item.memory_id,
    namespace: item.namespace,
    key: item.key,
    value: item.vault_ref !== undefined ? "[vault]" : item.value,
    scope: item.scope,
    source_kind: item.source_kind,
    confidence: item.confidence,
    sensitivity: item.sensitivity,
    status: item.status,
    version: item.version,
  };
}

export interface MemoryStoreOptions {
  db: DatabaseSync;
  vault: PrivateVault;
  now?: () => string;
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly vault: PrivateVault;
  private readonly now: () => string;
  /** 审查 P3：检索日志清理节流（上次清理时间；每小时最多一次）。 */
  private lastRetrievalPrune: string | null = null;

  constructor(options: MemoryStoreOptions) {
    this.db = options.db;
    this.vault = options.vault;
    // Normalize to UTC ISO (lexicographic timestamp comparisons in SQLite).
    const clock = options.now ?? (() => new Date().toISOString());
    this.now = () => new Date(Date.parse(clock())).toISOString();
  }

  // ---- principals ---------------------------------------------------------

  /** Create or return the principal. Role and owner are immutable — mismatch fails closed. */
  ensurePrincipal(input: {
    principal_id: string;
    owner_id: string;
    role: "buyer" | "merchant";
    display_name?: string;
    locale?: string;
    timezone?: string;
  }): Principal {
    const existing = this.getPrincipal(input.principal_id);
    const now = this.now();
    if (existing !== undefined) {
      if (existing.role !== input.role || existing.owner_id !== input.owner_id) {
        throw new MemoryError(
          "conflict",
          `principal ${input.principal_id} is bound to ${existing.role}/${existing.owner_id}; ` +
            `role and owner are immutable (physical isolation between agents)`,
        );
      }
      return existing;
    }
    // One principal per agent database (design §17): a database that already
    // belongs to another principal can never adopt a second identity.
    const other = this.db.prepare("SELECT principal_id FROM principals LIMIT 1").get() as
      | { principal_id: string }
      | undefined;
    if (other !== undefined) {
      throw new MemoryError(
        "conflict",
        `this memory database belongs to ${other.principal_id}; ` +
          `physical isolation between agents forbids binding ${input.principal_id}`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO principals
           (principal_id, owner_id, role, display_name, locale, timezone, memory_schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.principal_id,
        input.owner_id,
        input.role,
        input.display_name ?? null,
        input.locale ?? "zh-CN",
        input.timezone ?? "Asia/Shanghai",
        MEMORY_SCHEMA_VERSION,
        now,
        now,
      );
    return this.getPrincipal(input.principal_id) as Principal;
  }

  getPrincipal(principalId: string): Principal | undefined {
    const row = this.db
      .prepare("SELECT * FROM principals WHERE principal_id = ?")
      .get(principalId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      principal_id: row.principal_id as string,
      owner_id: row.owner_id as string,
      role: row.role as "buyer" | "merchant",
      display_name: (row.display_name as string | null) ?? undefined,
      locale: row.locale as string,
      timezone: row.timezone as string,
      memory_schema_version: row.memory_schema_version as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  // ---- write path ---------------------------------------------------------

  remember(input: RememberInput): RememberOutcome {
    // Precise personal data escalates to the Vault before validation, so a
    // model mislabeling an address as `private`/`normal` is still sealed.
    const effective = escalateSensitivity(input);
    this.validateRemember(effective);
    const now = this.now();
    this.db.exec("BEGIN");
    try {
      const outcome = this.rememberTx(effective, now);
      this.db.exec("COMMIT");
      return outcome;
    } catch (err) {
      this.db.exec("ROLLBACK");
      if (err instanceof MemoryError || err instanceof VaultKeyError) throw err;
      throw new MemoryError("validation", err instanceof Error ? err.message : String(err));
    }
  }

  private validateRemember(input: RememberInput): void {
    if (!isMemoryNamespace(input.namespace)) {
      throw new MemoryError("validation", `unknown namespace: ${String(input.namespace)}`);
    }
    if (typeof input.key !== "string" || input.key.length === 0 || input.key.length > 160) {
      throw new MemoryError("validation", "key must be a non-empty string (<= 160 chars)");
    }
    if (!isMemorySourceKind(input.source_kind)) {
      throw new MemoryError("validation", `unknown source_kind: ${String(input.source_kind)}`);
    }
    if (!isMemorySensitivity(input.sensitivity)) {
      throw new MemoryError("validation", `unknown sensitivity: ${String(input.sensitivity)}`);
    }
    if ((input.value === undefined) === (input.restricted === undefined)) {
      throw new MemoryError(
        "validation",
        "exactly one of value / restricted must be provided (value_json and vault_ref are mutually exclusive)",
      );
    }
    assertJsonValue(input.value, "value");
    parseMemoryScope(input.scope);
    if (input.namespace === "constraint" && input.source_kind !== "explicit") {
      throw new MemoryError(
        "validation",
        "hard constraints require an explicit source; inferred/observed signals can never become constraints",
      );
    }
    if (input.sensitivity === "restricted") {
      if (input.restricted === undefined) {
        throw new MemoryError("validation", "restricted memories must carry a Vault plaintext");
      }
      if (!isVaultKind(input.restricted.kind)) {
        throw new MemoryError("validation", `unknown vault kind: ${String(input.restricted.kind)}`);
      }
      if (input.source_kind !== "explicit") {
        throw new MemoryError(
          "validation",
          "Restricted memories require an explicit source (or a user-confirmed candidate)",
        );
      }
      if (!input.explicit_user_statement) {
        throw new MemoryError(
          "validation",
          "Restricted memories require an explicit user statement",
        );
      }
      if (!this.vault.available) {
        throw new MemoryError(
          "vault_unavailable",
          "no data key configured (KIWI_DATA_KEY); refusing Restricted write (fail closed)",
        );
      }
    }
    if (input.restricted !== undefined && input.sensitivity !== "restricted") {
      throw new MemoryError(
        "validation",
        "a Vault plaintext requires sensitivity=restricted",
      );
    }
    if (input.expires_at !== undefined) {
      if (Number.isNaN(Date.parse(input.expires_at))) {
        throw new MemoryError("validation", "expires_at must be an RFC3339 timestamp");
      }
      // Normalize to UTC ISO: expireDue compares lexicographically against a
      // UTC-Z now, so a "+08:00" input would otherwise silently never expire.
      input.expires_at = new Date(Date.parse(input.expires_at)).toISOString();
    }
    if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
      throw new MemoryError("validation", "confidence must be in [0, 1]");
    }
  }

  private rememberTx(input: RememberInput, now: string): RememberOutcome {
    const principal = this.requirePrincipal();
    const scope = parseMemoryScope(input.scope);

    const existing = this.findLiveByKey(principal.principal_id, input.namespace, input.key, scope);
    if (existing !== undefined) {
      return this.mergeOrConflict(existing, input, scope, now);
    }

    // Constraint/restricted memories can never auto-activate from a model
    // remember call — they stay candidate until the human /confirms them.
    // 审查 P2-G：系统落账的 episode（kernel rememberNegotiation，actor=
    // system）是可信操作记录，直接 active（检索可达、/why 可查、跨重启
    // 可恢复）——此前恒为 candidate 且无自动激活路径，retrieve 永不返回，
    // 磋商结果记忆是注释级死功能。模型经 remember 工具写入的 episode
    // （actor=model）保持 candidate（fail-closed，不信任模型内容）。
    const explicitConfirmed =
      (input.explicit_user_statement && !requiresHumanConfirm(input)) ||
      (input.namespace === "episode" && input.actor === "system");
    const status: MemoryStatus = explicitConfirmed ? "active" : "candidate";
    const confidence = explicitConfirmed
      ? 1.0
      : (input.confidence ?? DEFAULT_CONFIDENCE[input.source_kind]);

    const item = this.insertItem(
      principal.principal_id,
      input,
      scope,
      status,
      confidence,
      explicitConfirmed ? now : undefined,
      now,
    );
    this.addEvidenceTx(
      item.memory_id,
      { ...input.evidence, polarity: "support", summary: evidenceSummaryFor(input, input.evidence.summary) },
      now,
      true,
    );
    this.appendEvent(
      item.memory_id,
      explicitConfirmed ? "memory.confirmed" : "memory.proposed",
      input.actor,
      undefined,
      { after: auditSnapshot({ ...item, evidence_count: 1 }) },
      now,
    );
    return { kind: explicitConfirmed ? "active" : "candidate", memory: { ...item, evidence_count: 1 } };
  }

  /** Same live (namespace, key, scope): merge evidence or handle a value conflict. */
  private mergeOrConflict(
    existing: MemoryItem,
    input: RememberInput,
    scope: MemoryScope,
    now: string,
  ): RememberOutcome {
    const sameValue =
      existing.vault_ref === undefined &&
      input.restricted === undefined &&
      JSON.stringify(existing.value) === JSON.stringify(input.value);

    if (sameValue) {
      const added = this.addEvidenceTx(
        existing.memory_id,
        { ...input.evidence, polarity: "support", summary: evidenceSummaryFor(input, input.evidence.summary) },
        now,
        true,
      );
      const updated = this.getMemory(existing.memory_id) as MemoryItem;
      this.maybeAutoActivate(updated, now);
      return { kind: "merged", memory: this.getMemory(existing.memory_id) as MemoryItem, evidence_added: added };
    }

    // Value conflict. A recent explicit user statement supersedes; anything
    // weaker only appends contradict evidence — never a silent overwrite.
    if (input.explicit_user_statement) {
      this.db
        .prepare("UPDATE memory_items SET status = 'superseded', updated_at = ? WHERE memory_id = ?")
        .run(now, existing.memory_id);
      this.appendEvent(
        existing.memory_id,
        "memory.superseded",
        input.actor,
        "replaced by a newer explicit statement",
        { before: auditSnapshot(existing), after: { status: "superseded" } },
        now,
      );
      const humanConfirm = requiresHumanConfirm(input);
      const item = this.insertItem(
        existing.principal_id,
        input,
        scope,
        humanConfirm ? "candidate" : "active",
        humanConfirm ? (input.confidence ?? DEFAULT_CONFIDENCE[input.source_kind]) : 1.0,
        humanConfirm ? undefined : now,
        now,
      );
      this.addEvidenceTx(
        item.memory_id,
        { ...input.evidence, polarity: "support", summary: evidenceSummaryFor(input, input.evidence.summary) },
        now,
        true,
      );
      this.appendEvent(item.memory_id, humanConfirm ? "memory.proposed" : "memory.confirmed", input.actor, undefined, {
        after: auditSnapshot({ ...item, evidence_count: 1 }),
      }, now);
      return { kind: humanConfirm ? "candidate" : "active", memory: { ...item, evidence_count: 1 } };
    }

    const added = this.addEvidenceTx(
      existing.memory_id,
      { ...input.evidence, polarity: "contradict", summary: evidenceSummaryFor(input, input.evidence.summary) },
      now,
      false,
    );
    if (added) {
      this.appendEvent(
        existing.memory_id,
        "memory.contradicted",
        input.actor,
        evidenceSummaryFor(input, input.evidence.summary),
        { before: auditSnapshot(existing) },
        now,
      );
    }
    return {
      kind: "conflict",
      existing: this.getMemory(existing.memory_id) as MemoryItem,
      evidence_added: added,
    };
  }

  private insertItem(
    principalId: string,
    input: RememberInput,
    scope: MemoryScope,
    status: MemoryStatus,
    confidence: number,
    confirmedAt: string | undefined,
    now: string,
  ): MemoryItem {
    const memoryId = `mem_${uuidv7()}`;
    let valueJson: string | null = null;
    let vaultRef: string | null = null;
    if (input.restricted !== undefined) {
      vaultRef = this.sealVault(principalId, input.restricted.kind, input.restricted.plaintext, now);
    } else {
      valueJson = JSON.stringify(input.value ?? null);
    }
    this.db
      .prepare(
        `INSERT INTO memory_items
           (memory_id, principal_id, namespace, key, value_json, vault_ref, scope_json,
            source_kind, confidence, sensitivity, status, confirmed_at, valid_from, expires_at,
            last_observed_at, evidence_count, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      )
      .run(
        memoryId,
        principalId,
        input.namespace,
        input.key,
        valueJson,
        vaultRef,
        JSON.stringify(scope),
        input.source_kind,
        confidence,
        input.sensitivity,
        status,
        confirmedAt ?? null,
        now,
        input.expires_at ?? null,
        now,
        now,
        now,
      );
    return this.getMemory(memoryId) as MemoryItem;
  }

  private sealVault(principalId: string, kind: VaultKind, plaintext: string, now: string): string {
    const fingerprint = this.vault.fingerprint(kind, plaintext);
    const existing = this.db
      .prepare(
        "SELECT vault_ref FROM private_vault WHERE principal_id = ? AND kind = ? AND value_fingerprint = ?",
      )
      .get(principalId, kind, fingerprint) as { vault_ref: string } | undefined;
    if (existing !== undefined) return existing.vault_ref;
    const sealed = this.vault.seal(kind, plaintext);
    const ref = `vr_${uuidv7()}`;
    this.db
      .prepare(
        `INSERT INTO private_vault
           (vault_ref, principal_id, kind, ciphertext, nonce, key_version, value_fingerprint,
            retention_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        ref,
        principalId,
        kind,
        sealed.ciphertext,
        sealed.nonce,
        sealed.key_version,
        sealed.value_fingerprint,
        now,
        now,
      );
    return ref;
  }

  // ---- evidence -----------------------------------------------------------

  /**
   * Add evidence. Dedup (design §9.3): a repeat from the same source_ref
   * never inflates evidence_count; only supporting, deduplicated evidence
   * counts. Returns true when a new evidence row was inserted.
   */
  private addEvidenceTx(
    memoryId: string,
    input: EvidenceInput & { polarity: "support" | "contradict" },
    now: string,
    counts: boolean,
  ): boolean {
    const dup = this.db
      .prepare("SELECT 1 AS x FROM memory_evidence WHERE memory_id = ? AND source_ref = ? LIMIT 1")
      .get(memoryId, input.source_ref);
    if (dup !== undefined) return false;
    const evidenceId = `ev_${uuidv7()}`;
    this.db
      .prepare(
        `INSERT INTO memory_evidence
           (evidence_id, memory_id, source_type, source_ref, polarity, weight, summary, observed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidenceId,
        memoryId,
        input.source_type,
        input.source_ref,
        input.polarity,
        Math.min(1, Math.max(0, input.weight ?? 1)),
        input.summary,
        input.observed_at ?? now,
        now,
      );
    if (counts && input.polarity === "support") {
      this.db
        .prepare(
          `UPDATE memory_items
           SET evidence_count = (SELECT COUNT(DISTINCT source_ref) FROM memory_evidence
                                   WHERE memory_id = ? AND polarity = 'support'),
               last_observed_at = ?, updated_at = ?
           WHERE memory_id = ?`,
        )
        .run(memoryId, now, now, memoryId);
    }
    return true;
  }

  /** >= 3 deduplicated signals activate a soft preference (design §10.1). */
  private maybeAutoActivate(item: MemoryItem, now: string): void {
    if (item.status !== "candidate") return;
    if (!SOFT_ACTIVATABLE.has(item.namespace)) return;
    if (item.source_kind !== "observed" && item.source_kind !== "inferred") return;
    if (item.sensitivity === "restricted") return;
    if (item.evidence_count < AUTO_ACTIVATE_EVIDENCE) return;
    const confidence = Math.min(0.9, Math.max(item.confidence, 0.5 + 0.1 * item.evidence_count));
    this.db
      .prepare(
        "UPDATE memory_items SET status = 'active', confidence = ?, updated_at = ? WHERE memory_id = ?",
      )
      .run(confidence, now, item.memory_id);
    this.appendEvent(item.memory_id, "memory.activated", "system", "evidence threshold reached", {
      before: auditSnapshot(item),
      after: { status: "active", confidence },
    }, now);
  }

  /** Public evidence hook (task feedback, selections, rejections). */
  addEvidence(memoryId: string, input: EvidenceInput & { polarity?: "support" | "contradict" }): boolean {
    const now = this.now();
    this.db.exec("BEGIN");
    try {
      const added = this.addEvidenceTx(
        memoryId,
        { ...input, polarity: input.polarity ?? "support" },
        now,
        true,
      );
      if (added) {
        const item = this.getMemory(memoryId);
        if (item !== undefined) this.maybeAutoActivate(item, now);
      }
      this.db.exec("COMMIT");
      return added;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- user governance ----------------------------------------------------

  /** User confirms a candidate (design: Restricted candidates become valid only here). */
  confirmMemory(memoryId: string, actor: string): MemoryItem {
    const now = this.now();
    const item = this.requireMemory(memoryId);
    if (item.status !== "candidate" && item.status !== "needs_review") {
      throw new MemoryError("conflict", `memory ${memoryId} is ${item.status}, not confirmable`);
    }
    const confidence = item.source_kind === "explicit" ? 1.0 : Math.max(item.confidence, 0.9);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE memory_items
           SET status = 'active', confirmed_at = ?, confidence = ?, source_kind = 'explicit', updated_at = ?
           WHERE memory_id = ?`,
        )
        .run(now, confidence, now, memoryId);
      this.appendEvent(memoryId, "memory.confirmed", actor, undefined, {
        before: auditSnapshot(item),
        after: { status: "active", confidence },
      }, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getMemory(memoryId) as MemoryItem;
  }

  /**
   * User correction (design §6.4 /correct): updates in place with a version
   * bump and a before/after audit event. A correction IS an explicit user
   * statement: source becomes explicit, confidence 1.0, confirmed.
   * Restricted items keep their Vault value unless a new plaintext is given;
   * sensitivity downgrades from restricted are refused.
   */
  correctMemory(
    memoryId: string,
    patch: { value?: unknown; restricted?: { kind: VaultKind; plaintext: string }; scope?: MemoryScope },
    actor: string,
    reason?: string,
  ): MemoryItem {
    const item = this.requireMemory(memoryId);
    if (item.status === "deleted" || item.status === "superseded" || item.status === "expired") {
      throw new MemoryError("conflict", `memory ${memoryId} is ${item.status}; cannot correct`);
    }
    const now = this.now();
    this.db.exec("BEGIN");
    try {
      let valueJson: string | null | undefined;
      let vaultRef: string | null | undefined;
      if (patch.restricted !== undefined) {
        if (item.sensitivity !== "restricted") {
          throw new MemoryError(
            "validation",
            "cannot move a non-restricted memory into the Vault; forget it and remember again",
          );
        }
        if (!this.vault.available) {
          throw new MemoryError("vault_unavailable", "no data key configured (KIWI_DATA_KEY)");
        }
        vaultRef = this.sealVault(item.principal_id, patch.restricted.kind, patch.restricted.plaintext, now);
        valueJson = null;
      } else if (patch.value !== undefined) {
        if (item.sensitivity === "restricted") {
          throw new MemoryError(
            "validation",
            "cannot move a Restricted value out of the Vault; forget it and remember again",
          );
        }
        assertJsonValue(patch.value, "value");
        valueJson = JSON.stringify(patch.value);
        vaultRef = null;
      }
      const scopeJson = patch.scope !== undefined ? JSON.stringify(parseMemoryScope(patch.scope)) : undefined;
      this.db
        .prepare(
          `UPDATE memory_items
           SET value_json = COALESCE(?, value_json),
               vault_ref = COALESCE(?, vault_ref),
               scope_json = COALESCE(?, scope_json),
               source_kind = 'explicit', confidence = 1.0, confirmed_at = ?,
               status = CASE WHEN status = 'candidate' THEN 'active' ELSE status END,
               version = version + 1, updated_at = ?
           WHERE memory_id = ?`,
        )
        .run(
          valueJson === undefined ? null : valueJson,
          vaultRef === undefined ? null : vaultRef,
          scopeJson === undefined ? null : scopeJson,
          now,
          now,
          memoryId,
        );
      const updated = this.getMemory(memoryId) as MemoryItem;
      this.appendEvent(memoryId, "memory.corrected", actor, reason, {
        before: auditSnapshot(item),
        after: auditSnapshot(updated),
      }, now);
      this.db.exec("COMMIT");
      return updated;
    } catch (err) {
      this.db.exec("ROLLBACK");
      if (err instanceof MemoryError || err instanceof VaultKeyError) throw err;
      throw new MemoryError("validation", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Forget (tombstone + audit; design §9.2). The Vault ciphertext of a
   * Restricted memory is hard-deleted; retrieval never returns the item.
   */
  forgetMemory(memoryId: string, actor: string, reason?: string): MemoryItem {
    const item = this.requireMemory(memoryId);
    if (item.status === "deleted") return item;
    const now = this.now();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE memory_items SET status = 'deleted', updated_at = ? WHERE memory_id = ?")
        .run(now, memoryId);
      // Vault rows are fingerprint-deduped and can be shared by several memory
      // items (design §9.5). Only erase the ciphertext when no OTHER live item
      // still references it — otherwise /forget of one would silently destroy
      // the other's private value.
      if (item.vault_ref !== undefined) {
        const stillReferenced = this.db
          .prepare(
            "SELECT COUNT(*) AS c FROM memory_items WHERE vault_ref = ? AND memory_id != ? AND status != 'deleted'",
          )
          .get(item.vault_ref, memoryId) as { c: number };
        if (stillReferenced.c === 0) {
          this.db.prepare("DELETE FROM private_vault WHERE vault_ref = ?").run(item.vault_ref);
        }
      }
      this.appendEvent(memoryId, "memory.forgotten", actor, reason, {
        before: auditSnapshot(item),
        after: { status: "deleted", vault: item.vault_ref !== undefined ? "erased" : undefined },
      }, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getMemory(memoryId) as MemoryItem;
  }

  /** Expire due items (task_context after its task, dated memories at expires_at). */
  expireDue(): number {
    const now = this.now();
    const due = this.db
      .prepare(
        `SELECT memory_id FROM memory_items
         WHERE status IN ('candidate','active','needs_review') AND expires_at IS NOT NULL AND expires_at < ?`,
      )
      .all(now) as { memory_id: string }[];
    this.db.exec("BEGIN");
    try {
      for (const { memory_id: dueId } of due) {
        const item = this.getMemory(dueId) as MemoryItem;
        this.db
          .prepare("UPDATE memory_items SET status = 'expired', updated_at = ? WHERE memory_id = ?")
          .run(now, dueId);
        this.appendEvent(dueId, "memory.expired", "system", `expired at ${item.expires_at ?? ""}`, {
          before: auditSnapshot(item),
          after: { status: "expired" },
        }, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return due.length;
  }

  // ---- retrieval ----------------------------------------------------------

  retrieve(query: RetrieveQuery): RetrievedMemory[] {
    if (!isRetrievalPurpose(query.purpose)) {
      throw new MemoryError("validation", `unknown retrieval purpose: ${String(query.purpose)}`);
    }
    const principal = this.requirePrincipal();
    this.expireDue();
    const now = this.now();
    // 审查 P3：检索日志每 retrieve 一行、只增不减——顺带按小时节流清理
    // 30 天前的行（审计/调优保留期；失败不影响检索本身）。
    if (this.lastRetrievalPrune === null || Date.parse(now) - Date.parse(this.lastRetrievalPrune) > 60 * 60 * 1000) {
      this.lastRetrievalPrune = now;
      try {
        this.pruneRetrievalLog(now);
      } catch {
        // 清理失败不影响检索（fail-safe 方向；下次再试）
      }
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? 8));

    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE principal_id = ? AND status IN ('active','needs_review')`,
      )
      .all(principal.principal_id) as unknown as ItemRow[];

    const queryTokens = tokenize(query.text);
    const scored: RetrievedMemory[] = [];
    for (const row of rows) {
      const item = this.rowToItem(row);
      if (query.namespaces !== undefined && !query.namespaces.includes(item.namespace)) continue;
      if (item.namespace === "task_context") {
        if (query.task_id === undefined || item.scope.task_id !== query.task_id) continue;
      }
      const scopeMatch = scopeScore(item.scope, query.scopes);
      if (scopeMatch === 0) continue;
      const relevance = relevanceScore(item, queryTokens);
      const freshness = freshnessScore(item, now);
      const penalty = item.status === "needs_review" ? 0.5 : 1;
      const score =
        relevance *
        scopeMatch *
        item.confidence *
        freshness *
        SOURCE_WEIGHT[item.source_kind] *
        penalty;
      scored.push({
        memory_id: item.memory_id,
        namespace: item.namespace,
        key: item.key,
        ...(item.vault_ref === undefined ? { value: item.value } : {}),
        scope: item.scope,
        source_kind: item.source_kind,
        confidence: item.confidence,
        sensitivity: item.sensitivity,
        status: item.status as "active" | "needs_review",
        redaction_level: redactionLevel(item.sensitivity),
        score,
        ...(item.last_observed_at !== undefined
          ? { last_observed_at: item.last_observed_at }
          : {}),
      });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.memory_id.localeCompare(b.memory_id),
    );
    const picked = scored.slice(0, limit);
    for (const item of picked) {
      this.db
        .prepare(
          `INSERT INTO memory_retrieval_log
             (retrieval_id, task_id, session_id, memory_id, purpose, redaction_level, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `ret_${uuidv7()}`,
          query.task_id ?? null,
          query.session_id,
          item.memory_id,
          query.purpose,
          item.redaction_level,
          now,
        );
    }
    return picked;
  }

  /** 审查 P3：检索日志物理清理——保留期（默认 30 天）前的行删除，幂等
   *  可重复调。此前 memory_retrieval_log 只增不减，长跑 agent 库无界增长。 */
  pruneRetrievalLog(now: string, retentionDays = 30): number {
    const cutoff = new Date(Date.parse(now) - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db
      .prepare("DELETE FROM memory_retrieval_log WHERE created_at < ?")
      .run(cutoff);
    return Number(result.changes ?? 0);
  }

  /** Data behind /why: the most recent retrieval batch for a session. */
  explainLastRetrieval(sessionId: string): {
    entries: (RetrievalLogEntry & { key: string; namespace: MemoryNamespace; confidence: number })[];
  } {
    const last = this.db
      .prepare("SELECT created_at FROM memory_retrieval_log WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sessionId) as { created_at: string } | undefined;
    if (last === undefined) return { entries: [] };
    const rows = this.db
      .prepare(
        `SELECT l.*, i.key AS key, i.namespace AS namespace, i.confidence AS confidence
         FROM memory_retrieval_log l JOIN memory_items i ON i.memory_id = l.memory_id
         WHERE l.session_id = ? AND l.created_at = ?
         ORDER BY l.memory_id`,
      )
      .all(sessionId, last.created_at) as Record<string, unknown>[];
    return {
      entries: rows.map((r) => ({
        retrieval_id: r.retrieval_id as string,
        task_id: (r.task_id as string | null) ?? undefined,
        session_id: r.session_id as string,
        memory_id: r.memory_id as string,
        purpose: r.purpose as RetrievalPurpose,
        redaction_level: r.redaction_level as RedactionLevel,
        created_at: r.created_at as string,
        key: r.key as string,
        namespace: r.namespace as MemoryNamespace,
        confidence: r.confidence as number,
      })),
    };
  }

  retrievalLog(sessionId: string): RetrievalLogEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_retrieval_log WHERE session_id = ? ORDER BY created_at, memory_id")
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      retrieval_id: r.retrieval_id as string,
      task_id: (r.task_id as string | null) ?? undefined,
      session_id: r.session_id as string,
      memory_id: r.memory_id as string,
      purpose: r.purpose as RetrievalPurpose,
      redaction_level: r.redaction_level as RedactionLevel,
      created_at: r.created_at as string,
    }));
  }

  // ---- reads / listings ---------------------------------------------------

  getMemory(memoryId: string): MemoryItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory_items WHERE memory_id = ?")
      .get(memoryId) as unknown as ItemRow | undefined;
    return row === undefined ? undefined : this.rowToItem(row);
  }

  /** /memory overview. Restricted items are listed without any value. */
  listMemories(filter: {
    namespace?: MemoryNamespace;
    sensitivity?: MemorySensitivity;
    statuses?: MemoryStatus[];
  }): MemoryItem[] {
    const principal = this.requirePrincipal();
    const statuses = filter.statuses ?? ["candidate", "active", "needs_review"];
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE principal_id = ?
           AND (${statuses.map(() => "status = ?").join(" OR ")})
           AND (? IS NULL OR namespace = ?)
           AND (? IS NULL OR sensitivity = ?)
         ORDER BY namespace, key`,
      )
      .all(
        principal.principal_id,
        ...statuses,
        filter.namespace ?? null,
        filter.namespace ?? null,
        filter.sensitivity ?? null,
        filter.sensitivity ?? null,
      ) as unknown as ItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  memoryEvents(memoryId: string): MemoryEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_events WHERE memory_id = ? ORDER BY created_at, event_id")
      .all(memoryId) as Record<string, unknown>[];
    return rows.map((r) => ({
      event_id: r.event_id as string,
      memory_id: r.memory_id as string,
      type: r.type as MemoryEventType,
      actor: r.actor as string,
      reason: (r.reason as string | null) ?? undefined,
      before_json: r.before_json === null ? undefined : JSON.parse(r.before_json as string),
      after_json: r.after_json === null ? undefined : JSON.parse(r.after_json as string),
      created_at: r.created_at as string,
    }));
  }

  /** Vault metadata for /memory private — never ciphertext, never plaintext. */
  vaultEntries(): { vault_ref: string; kind: VaultKind; created_at: string }[] {
    const principal = this.requirePrincipal();
    const rows = this.db
      .prepare(
        "SELECT vault_ref, kind, created_at FROM private_vault WHERE principal_id = ? ORDER BY created_at",
      )
      .all(principal.principal_id) as Record<string, unknown>[];
    return rows.map((r) => ({
      vault_ref: r.vault_ref as string,
      kind: r.kind as VaultKind,
      created_at: r.created_at as string,
    }));
  }

  /** Open a Vault value (owner-side use only; never exposed to the model). */
  openVaultValue(vaultRef: string): string {
    const principal = this.requirePrincipal();
    const row = this.db
      .prepare("SELECT * FROM private_vault WHERE vault_ref = ? AND principal_id = ?")
      .get(vaultRef, principal.principal_id) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new MemoryError("not_found", `no vault entry ${vaultRef}`);
    }
    return this.vault.open(
      row.key_version as number,
      row.nonce as Buffer,
      row.ciphertext as Buffer,
    );
  }

  // ---- internals ----------------------------------------------------------

  private principalId?: string;

  /** Bind the store to one principal (set by the kernel after ensurePrincipal). */
  bindPrincipal(principalId: string): void {
    this.principalId = principalId;
  }

  private requirePrincipal(): Principal {
    if (this.principalId === undefined) {
      throw new MemoryError("validation", "MemoryStore is not bound to a principal");
    }
    const principal = this.getPrincipal(this.principalId);
    if (principal === undefined) {
      throw new MemoryError("not_found", `principal ${this.principalId} does not exist`);
    }
    return principal;
  }

  private requireMemory(memoryId: string): MemoryItem {
    const item = this.getMemory(memoryId);
    if (item === undefined) {
      throw new MemoryError("not_found", `no memory ${memoryId}`);
    }
    return item;
  }

  private findLiveByKey(
    principalId: string,
    namespace: MemoryNamespace,
    key: string,
    scope: MemoryScope,
  ): MemoryItem | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE principal_id = ? AND namespace = ? AND key = ? AND scope_json = ?
           AND status IN ('candidate','active','needs_review')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(principalId, namespace, key, JSON.stringify(scope)) as unknown as ItemRow | undefined;
    return row === undefined ? undefined : this.rowToItem(row);
  }

  private rowToItem(row: ItemRow): MemoryItem {
    const item: MemoryItem = {
      memory_id: row.memory_id,
      principal_id: row.principal_id,
      namespace: row.namespace as MemoryItem["namespace"],
      key: row.key,
      scope: JSON.parse(row.scope_json) as MemoryScope,
      source_kind: row.source_kind as MemoryItem["source_kind"],
      confidence: row.confidence,
      sensitivity: row.sensitivity as MemoryItem["sensitivity"],
      status: row.status as MemoryItem["status"],
      evidence_count: row.evidence_count,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (row.value_json !== null) item.value = JSON.parse(row.value_json);
    if (row.vault_ref !== null) item.vault_ref = row.vault_ref;
    const confirmed = optText(row.confirmed_at);
    if (confirmed !== undefined) item.confirmed_at = confirmed;
    const validFrom = optText(row.valid_from);
    if (validFrom !== undefined) item.valid_from = validFrom;
    const expires = optText(row.expires_at);
    if (expires !== undefined) item.expires_at = expires;
    const observed = optText(row.last_observed_at);
    if (observed !== undefined) item.last_observed_at = observed;
    return item;
  }

  private appendEvent(
    memoryId: string,
    type: MemoryEventType,
    actor: string,
    reason: string | undefined,
    snapshots: { before?: unknown; after?: unknown },
    now: string,
  ): void {
    for (const [label, snap] of [
      ["before", snapshots.before],
      ["after", snapshots.after],
    ] as const) {
      if (snap !== undefined) assertJsonValue(snap, `memory_event.${label}`);
    }
    this.db
      .prepare(
        `INSERT INTO memory_events
           (event_id, memory_id, type, actor, reason, before_json, after_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `mev_${uuidv7()}`,
        memoryId,
        type,
        actor,
        reason ?? null,
        snapshots.before === undefined ? null : JSON.stringify(snapshots.before),
        snapshots.after === undefined ? null : JSON.stringify(snapshots.after),
        now,
      );
  }
}

function redactionLevel(sensitivity: MemorySensitivity): RedactionLevel {
  return sensitivity === "restricted" ? "metadata_only" : sensitivity === "private" ? "coarse" : "full";
}

/** Deterministic tokenizer for relevance matching (CJK bigrams + word tokens). */
function tokenize(text: string | undefined): string[] {
  if (text === undefined || text.trim() === "") return [];
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z0-9_]{2,}/g) ?? [];
  const cjk = lower.match(/[一-鿿]/g) ?? [];
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < cjk.length; i++) bigrams.push(`${cjk[i]}${cjk[i + 1]}`);
  return [...new Set([...words, ...bigrams])];
}

function relevanceScore(item: MemoryItem, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 1;
  const haystack = `${item.key} ${JSON.stringify(item.value ?? "")}`.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return Math.min(1, Math.max(0.1, hits / queryTokens.length + (hits > 0 ? 0.2 : 0)));
}

function scopeScore(scope: MemoryScope, queryScopes: MemoryScope[] | undefined): number {
  const entries = Object.entries(scope).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return 1.0; // global memory
  if (queryScopes === undefined || queryScopes.length === 0) return 0.6; // scoped memory, global query
  let matched = false;
  for (const [dimension, value] of entries) {
    for (const qs of queryScopes) {
      const qv = qs[dimension as keyof MemoryScope];
      if (qv === undefined) continue;
      if (qv === value) matched = true;
      else return 0.4; // explicit contradiction on a shared dimension
    }
  }
  return matched ? 1.2 : 0.6;
}

function freshnessScore(item: MemoryItem, now: string): number {
  if (item.last_observed_at === undefined) return 1;
  const ageMs = Date.parse(now) - Date.parse(item.last_observed_at);
  const ageDays = Math.max(0, ageMs / 86_400_000);
  return 0.5 + 0.5 * Math.exp(-ageDays / 90);
}
