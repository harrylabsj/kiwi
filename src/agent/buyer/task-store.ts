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
 * Buyer task store (design §11.2–§11.7): state machine with optimistic
 * versioning, idempotent task events, deduplicated candidates and
 * observations, and tracking rules. Same SQLite database as memory —
 * every transition is transactional.
 */

import type { DatabaseSync } from "node:sqlite";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { PrivateVault } from "../memory/vault.js";
import type { VaultKind } from "../memory/types.js";
import type {
  BuyerTask,
  BuyerTaskStatus,
  CandidateStatus,
  ConsultationLink,
  ConsultationLinkStatus,
  ProductCandidate,
  ProductObservation,
  RankingPolicy,
  SearchBudget,
  TaskConstraints,
  TaskEvent,
  TaskIntent,
  TrackingPolicy,
  TrackingRule,
  TrackingRuleType,
} from "./types.js";
import {
  BuyerTaskError,
  DEFAULT_SEARCH_BUDGET,
  DEFAULT_TRACKING_POLICY,
  TASK_TRANSITIONS,
} from "./types.js";

export interface BuyerTaskStoreOptions {
  db: DatabaseSync;
  principalId: string;
  now?: () => string;
  /** Optional Vault for private budget sealing (design §11.2, §6.3). */
  vault?: PrivateVault;
}

interface TaskRow {
  task_id: string;
  principal_id: string;
  status: string;
  goal_text: string;
  intent_json: string;
  constraints_json: string;
  ranking_policy_json: string;
  connector_scope_json: string;
  search_budget_json: string;
  tracking_policy_json: string;
  selected_candidate_id: string | null;
  next_run_at: string | null;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function opt(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

/**
 * Normalize a user/model-supplied RFC3339 to UTC ISO so the lexicographic
 * due/expiry comparisons (next_run_at <= now, expires_at < now) are correct
 * for mixed-offset inputs. Fail closed on non-timestamps.
 */
function normalizeIso(value: string | undefined | null): string | null | undefined {
  if (value === undefined || value === null) return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new BuyerTaskError("validation", "expires_at must be an RFC3339 timestamp");
  }
  return new Date(t).toISOString();
}

export class BuyerTaskStore {
  private readonly db: DatabaseSync;
  private readonly principalId: string;
  private readonly now: () => string;
  private readonly vault?: PrivateVault;

  constructor(options: BuyerTaskStoreOptions) {
    this.db = options.db;
    this.principalId = options.principalId;
    this.vault = options.vault;
    // Normalize to UTC ISO: SQLite compares timestamps lexicographically,
    // so mixed "+08:00"/"Z" spellings would silently break due checks.
    const clock = options.now ?? (() => new Date().toISOString());
    this.now = () => new Date(Date.parse(clock())).toISOString();
  }

  // ---- private budget sealing (design §11.2, §6.3) ---------------------------

  /**
   * A task-level private budget never lives in constraints_json as plaintext
   * when a data key is available: it is sealed into the Vault and stored as
   * `max_total_price_vault_ref`. Without a key it stays a number inside the
   * per-agent 0600 database (the same tier as the profile's private config);
   * either way the model-facing task output is redacted.
   */
  private sealConstraints(constraints: TaskConstraints): TaskConstraints {
    const price = constraints.max_total_price;
    if (price === undefined || constraints.max_total_price_vault_ref !== undefined) {
      return constraints;
    }
    if (!this.vault?.available) return constraints;
    return {
      ...constraints,
      max_total_price: undefined,
      max_total_price_vault_ref: this.sealVault("private_budget", String(price)),
    };
  }

  private sealVault(kind: VaultKind, plaintext: string): string {
    const vault = this.vault as PrivateVault;
    const now = this.now();
    const fingerprint = vault.fingerprint(kind, plaintext);
    const existing = this.db
      .prepare(
        "SELECT vault_ref FROM private_vault WHERE principal_id = ? AND kind = ? AND value_fingerprint = ?",
      )
      .get(this.principalId, kind, fingerprint) as { vault_ref: string } | undefined;
    if (existing !== undefined) return existing.vault_ref;
    const sealed = vault.seal(kind, plaintext);
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
        this.principalId,
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

  /** Resolve the effective task budget: plaintext number, or the Vault value. */
  resolveBudget(constraints: TaskConstraints): number | undefined {
    if (constraints.max_total_price !== undefined) return constraints.max_total_price;
    if (constraints.max_total_price_vault_ref === undefined) return undefined;
    if (this.vault === undefined) {
      throw new BuyerTaskError(
        "vault_unavailable",
        "task budget is vaulted but no vault is configured for this store",
      );
    }
    const row = this.db
      .prepare(
        "SELECT * FROM private_vault WHERE vault_ref = ? AND principal_id = ?",
      )
      .get(constraints.max_total_price_vault_ref, this.principalId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      throw new BuyerTaskError(
        "not_found",
        `no vault entry ${constraints.max_total_price_vault_ref}`,
      );
    }
    const value = this.vault.open(
      row.key_version as number,
      row.nonce as Buffer,
      row.ciphertext as Buffer,
    );
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  // ---- tasks ----------------------------------------------------------------

  createTask(input: {
    goal_text: string;
    intent: TaskIntent;
    constraints?: TaskConstraints;
    ranking_policy?: RankingPolicy;
    connector_scope?: { connectors: string[] };
    search_budget?: Partial<SearchBudget>;
    tracking_policy?: Partial<TrackingPolicy>;
    expires_at?: string;
    idempotency_key: string;
  }): BuyerTask {
    if (input.goal_text.trim() === "") {
      throw new BuyerTaskError("validation", "goal_text must not be empty");
    }
    const now = this.now();
    const taskId = `task_${uuidv7()}`;
    this.db.exec("BEGIN");
    try {
      // Content-addressed idempotency: a retried create with the same key is a
      // replay — return the existing task instead of duplicating it.
      const existing = this.eventByIdempotencyKey(input.idempotency_key);
      if (existing !== undefined) {
        const replayed = this.getTask(existing.task_id);
        if (replayed !== undefined) {
          this.db.exec("COMMIT");
          return replayed;
        }
      }
      this.db
        .prepare(
          `INSERT INTO buyer_tasks
             (task_id, principal_id, status, goal_text, intent_json, constraints_json,
              ranking_policy_json, connector_scope_json, search_budget_json, tracking_policy_json,
              next_run_at, expires_at, version, created_at, updated_at)
           VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
        )
        .run(
          taskId,
          this.principalId,
          input.goal_text,
          JSON.stringify(input.intent),
          JSON.stringify(this.sealConstraints(input.constraints ?? {})),
          JSON.stringify(input.ranking_policy ?? { weights: {}, sources: {} }),
          JSON.stringify(input.connector_scope ?? { connectors: ["shopping-cli"] }),
          JSON.stringify({ ...DEFAULT_SEARCH_BUDGET, ...input.search_budget }),
          JSON.stringify({ ...DEFAULT_TRACKING_POLICY, ...input.tracking_policy }),
          normalizeIso(input.expires_at) ?? null,
          now,
          now,
        );
      this.appendEventTx(taskId, "created", { goal_text: input.goal_text }, "user", input.idempotency_key, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getTask(taskId) as BuyerTask;
  }

  getTask(taskId: string): BuyerTask | undefined {
    const row = this.db
      .prepare("SELECT * FROM buyer_tasks WHERE task_id = ? AND principal_id = ?")
      .get(taskId, this.principalId) as unknown as TaskRow | undefined;
    return row === undefined ? undefined : this.rowToTask(row);
  }

  listTasks(filter: { statuses?: BuyerTaskStatus[] } = {}): BuyerTask[] {
    const statuses = filter.statuses ?? [
      "draft",
      "clarifying",
      "ready",
      "searching",
      "tracking",
      "shortlist_ready",
      "awaiting_user",
      "consulting",
      "negotiating",
    ];
    const rows = this.db
      .prepare(
        `SELECT * FROM buyer_tasks
         WHERE principal_id = ? AND (${statuses.map(() => "status = ?").join(" OR ")})
         ORDER BY created_at`,
      )
      .all(this.principalId, ...statuses) as unknown as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * Legal-transition state machine with optimistic versioning (§11.3):
   * the update carries expected_version so a background wakeup and a user
   * command can never silently overwrite each other. The transition event
   * is idempotent by idempotency_key (replays don't double-transition).
   */
  transitionTask(input: {
    task_id: string;
    to: BuyerTaskStatus;
    expected_version: number;
    event_type: string;
    payload?: Record<string, unknown>;
    origin: TaskEvent["origin"];
    idempotency_key: string;
    next_run_at?: string | null;
    selected_candidate_id?: string;
  }): BuyerTask {
    const now = this.now();
    this.db.exec("BEGIN");
    try {
      const existing = this.eventByIdempotencyKey(input.idempotency_key);
      if (existing !== undefined) {
        this.db.exec("COMMIT");
        return this.getTask(input.task_id) as BuyerTask; // replay: no-op
      }
      const task = this.getTask(input.task_id);
      if (task === undefined) {
        throw new BuyerTaskError("not_found", `no task ${input.task_id}`);
      }
      const legal = TASK_TRANSITIONS[task.status];
      if (!legal.includes(input.to)) {
        throw new BuyerTaskError(
          "illegal_transition",
          `task ${input.task_id}: ${task.status} -> ${input.to} is not a legal transition`,
        );
      }
      const updated = this.db
        .prepare(
          `UPDATE buyer_tasks
           SET status = ?, next_run_at = COALESCE(?, next_run_at),
               selected_candidate_id = COALESCE(?, selected_candidate_id),
               version = version + 1, updated_at = ?
           WHERE task_id = ? AND version = ?`,
        )
        .run(
          input.to,
          input.next_run_at === undefined ? null : input.next_run_at,
          input.selected_candidate_id ?? null,
          now,
          input.task_id,
          input.expected_version,
        );
      if (updated.changes !== 1) {
        throw new BuyerTaskError(
          "conflict",
          `task ${input.task_id} version conflict (expected ${input.expected_version}); another writer moved first`,
        );
      }
      this.appendEventTx(
        input.task_id,
        input.event_type,
        { from: task.status, to: input.to, ...input.payload },
        input.origin,
        input.idempotency_key,
        now,
      );
      this.db.exec("COMMIT");
      return this.getTask(input.task_id) as BuyerTask;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Patch constraints / intent / policies (no status change; version-guarded). */
  updateTask(
    taskId: string,
    patch: {
      intent?: TaskIntent;
      constraints?: TaskConstraints;
      ranking_policy?: RankingPolicy;
      next_run_at?: string | null;
      expires_at?: string | null;
    },
    expectedVersion: number,
    idempotencyKey: string,
  ): BuyerTask {
    const now = this.now();
    this.db.exec("BEGIN");
    try {
      if (this.eventByIdempotencyKey(idempotencyKey) === undefined) {
        const task = this.getTask(taskId);
        if (task === undefined) throw new BuyerTaskError("not_found", `no task ${taskId}`);
        const stmt = this.db.prepare(
          `UPDATE buyer_tasks
           SET intent_json = ?, constraints_json = ?, ranking_policy_json = ?,
               next_run_at = ?, expires_at = ?, version = version + 1, updated_at = ?
           WHERE task_id = ? AND version = ?`,
        );
        const res = stmt.run(
          JSON.stringify(patch.intent ?? task.intent),
          JSON.stringify(
            patch.constraints !== undefined ? this.sealConstraints(patch.constraints) : task.constraints,
          ),
          JSON.stringify(patch.ranking_policy ?? task.ranking_policy),
          patch.next_run_at === undefined ? (task.next_run_at ?? null) : patch.next_run_at,
          patch.expires_at === undefined
            ? (task.expires_at ?? null)
            : (normalizeIso(patch.expires_at) ?? null),
          now,
          taskId,
          expectedVersion,
        );
        if (res.changes !== 1) {
          throw new BuyerTaskError("conflict", `task ${taskId} version conflict`);
        }
        this.appendEventTx(taskId, "clarified", { patch: Object.keys(patch) }, "user", idempotencyKey, now);
      }
      this.db.exec("COMMIT");
      return this.getTask(taskId) as BuyerTask;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- events -----------------------------------------------------------------

  private appendEventTx(
    taskId: string,
    type: string,
    payload: Record<string, unknown>,
    origin: TaskEvent["origin"],
    idempotencyKey: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_events
           (event_id, task_id, type, payload_json, origin, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`tev_${uuidv7()}`, taskId, type, JSON.stringify(payload), origin, idempotencyKey, now);
  }

  /**
   * Idempotent standalone event (notifications, observations, merges).
   * Returns whether the row was newly inserted (false = idempotency replay),
   * so callers can skip duplicate user-visible notifications.
   */
  appendEvent(
    taskId: string,
    type: string,
    payload: Record<string, unknown>,
    origin: TaskEvent["origin"],
    idempotencyKey: string,
  ): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO task_events
           (event_id, task_id, type, payload_json, origin, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`tev_${uuidv7()}`, taskId, type, JSON.stringify(payload), origin, idempotencyKey, this.now());
    return res.changes === 1;
  }

  eventByIdempotencyKey(key: string): TaskEvent | undefined {
    const row = this.db
      .prepare("SELECT * FROM task_events WHERE idempotency_key = ?")
      .get(key) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.rowToEvent(row);
  }

  taskEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at, event_id")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEvent(r));
  }

  // ---- candidates & observations --------------------------------------------

  /**
   * Upsert by (task_id, canonical_key) — canonical_key is connector + SKU
   * (or connector + external product id), never the title (§11.5).
   */
  upsertCandidate(input: {
    task_id: string;
    connector_id: string;
    platform: string;
    external_product_id: string;
    sku?: string;
    merchant_id?: string;
    owner_agent_id?: string;
    merchant_name?: string;
  }): ProductCandidate {
    const now = this.now();
    const canonicalKey = `${input.connector_id}:${input.sku ?? input.external_product_id}`;
    const existing = this.db
      .prepare("SELECT * FROM product_candidates WHERE task_id = ? AND canonical_key = ?")
      .get(input.task_id, canonicalKey) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      // 复用已有候选：刷新 last_seen_at；owner_agent_id/merchant_name 非空时覆盖。
      this.db
        .prepare(
          "UPDATE product_candidates SET last_seen_at = ?, owner_agent_id = COALESCE(?, owner_agent_id), merchant_name = COALESCE(?, merchant_name) WHERE candidate_id = ?",
        )
        .run(
          now,
          input.owner_agent_id ?? null,
          input.merchant_name ?? null,
          existing.candidate_id as string,
        );
      return this.getCandidate(existing.candidate_id as string) as ProductCandidate;
    }
    const candidateId = `cand_${uuidv7()}`;
    this.db
      .prepare(
        `INSERT INTO product_candidates
           (candidate_id, task_id, connector_id, platform, external_product_id, sku, merchant_id,
            owner_agent_id, merchant_name, canonical_key, eligibility, candidate_status, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 'discovered', ?, ?)`,
      )
      .run(
        candidateId,
        input.task_id,
        input.connector_id,
        input.platform,
        input.external_product_id,
        input.sku ?? null,
        input.merchant_id ?? null,
        input.owner_agent_id ?? null,
        input.merchant_name ?? null,
        canonicalKey,
        now,
        now,
      );
    return this.getCandidate(candidateId) as ProductCandidate;
  }

  getCandidate(candidateId: string): ProductCandidate | undefined {
    const row = this.db
      .prepare("SELECT * FROM product_candidates WHERE candidate_id = ?")
      .get(candidateId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.rowToCandidate(row);
  }

  listCandidates(taskId: string, filter: { statuses?: CandidateStatus[] } = {}): ProductCandidate[] {
    const rows = this.db
      .prepare("SELECT * FROM product_candidates WHERE task_id = ? ORDER BY first_seen_at, candidate_id")
      .all(taskId) as Record<string, unknown>[];
    return rows
      .map((r) => this.rowToCandidate(r))
      .filter(
        (c) => filter.statuses === undefined || filter.statuses.includes(c.candidate_status),
      );
  }

  updateCandidate(
    candidateId: string,
    patch: {
      eligibility?: ProductCandidate["eligibility"];
      candidate_status?: CandidateStatus;
      score?: number;
      score_explanation?: unknown;
      rejection_reasons?: string[];
      latest_observation_id?: string;
      owner_agent_id?: string;
      merchant_name?: string;
    },
  ): ProductCandidate {
    const c = this.getCandidate(candidateId);
    if (c === undefined) throw new BuyerTaskError("not_found", `no candidate ${candidateId}`);
    this.db
      .prepare(
        `UPDATE product_candidates
         SET eligibility = ?, candidate_status = ?, score = ?, score_explanation_json = ?,
             rejection_reasons_json = ?, latest_observation_id = ?, owner_agent_id = ?,
             merchant_name = ?, last_seen_at = ?
         WHERE candidate_id = ?`,
      )
      .run(
        patch.eligibility ?? c.eligibility,
        patch.candidate_status ?? c.candidate_status,
        patch.score ?? c.score ?? null,
        patch.score_explanation !== undefined
          ? JSON.stringify(patch.score_explanation)
          : c.score_explanation !== undefined
            ? JSON.stringify(c.score_explanation)
            : null,
        patch.rejection_reasons !== undefined
          ? JSON.stringify(patch.rejection_reasons)
          : JSON.stringify(c.rejection_reasons),
        patch.latest_observation_id ?? c.latest_observation_id ?? null,
        patch.owner_agent_id ?? c.owner_agent_id ?? null,
        patch.merchant_name ?? c.merchant_name ?? null,
        this.now(),
        candidateId,
      );
    return this.getCandidate(candidateId) as ProductCandidate;
  }

  /** Dedup by content_hash: an identical observation is never stored twice (§11.6). */
  addObservation(input: Omit<ProductObservation, "observation_id">): {
    added: boolean;
    observation_id: string;
  } {
    const existing = this.db
      .prepare(
        "SELECT observation_id FROM product_observations WHERE candidate_id = ? AND content_hash = ?",
      )
      .get(input.candidate_id, input.content_hash) as { observation_id: string } | undefined;
    if (existing !== undefined) {
      // Same facts re-verified: keep observed_at for trend, but EXTEND the
      // freshness window — otherwise a repeatedly-rechecked unchanged fact
      // stays permanently stale and is misreported as "过期" (§11.6).
      this.db
        .prepare("UPDATE product_observations SET fresh_until = ? WHERE observation_id = ?")
        .run(input.fresh_until, existing.observation_id);
      return { added: false, observation_id: existing.observation_id };
    }
    const observationId = `obs_${uuidv7()}`;
    this.db
      .prepare(
        `INSERT INTO product_observations
           (observation_id, candidate_id, observed_at, source_url_or_ref, title,
            price_json, promotion_json, stock_json, delivery_json, after_sales_json,
            merchant_json, content_hash, fresh_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observationId,
        input.candidate_id,
        input.observed_at,
        input.source_url_or_ref,
        input.title,
        JSON.stringify(input.price),
        JSON.stringify(input.promotion),
        JSON.stringify(input.stock),
        JSON.stringify(input.delivery),
        JSON.stringify(input.after_sales),
        JSON.stringify(input.merchant),
        input.content_hash,
        input.fresh_until,
      );
    return { added: true, observation_id: observationId };
  }

  latestObservation(candidateId: string): ProductObservation | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM product_observations WHERE candidate_id = ? ORDER BY observed_at DESC LIMIT 1",
      )
      .get(candidateId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.rowToObservation(row);
  }

  observations(candidateId: string, limit = 20): ProductObservation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM product_observations WHERE candidate_id = ? ORDER BY observed_at DESC LIMIT ?",
      )
      .all(candidateId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToObservation(r));
  }

  // ---- tracking rules ---------------------------------------------------------

  addTrackingRule(input: {
    task_id: string;
    candidate_id?: string;
    rule_type: TrackingRuleType;
    condition: Record<string, unknown>;
    interval_seconds: number;
    cooldown_seconds?: number;
    idempotency_key: string;
  }): TrackingRule {
    if (!Number.isInteger(input.interval_seconds) || input.interval_seconds <= 0) {
      throw new BuyerTaskError("validation", "interval_seconds must be a positive integer");
    }
    const now = this.now();
    const ruleId = `rule_${uuidv7()}`;
    const next = new Date(Date.parse(now) + input.interval_seconds * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO tracking_rules
           (rule_id, task_id, candidate_id, rule_type, condition_json, interval_seconds,
            next_check_at, cooldown_seconds, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        ruleId,
        input.task_id,
        input.candidate_id ?? null,
        input.rule_type,
        JSON.stringify(input.condition),
        input.interval_seconds,
        next,
        input.cooldown_seconds ?? 0,
      );
    return this.getRule(ruleId) as TrackingRule;
  }

  getRule(ruleId: string): TrackingRule | undefined {
    const row = this.db
      .prepare("SELECT * FROM tracking_rules WHERE rule_id = ?")
      .get(ruleId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.rowToRule(row);
  }

  rulesForTask(taskId: string): TrackingRule[] {
    const rows = this.db
      .prepare("SELECT * FROM tracking_rules WHERE task_id = ? ORDER BY rule_id")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRule(r));
  }

  /** Rules due for a check (scheduler input). */
  dueRules(now: string, limit: number): TrackingRule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tracking_rules
         WHERE status = 'active' AND next_check_at <= ?
         ORDER BY next_check_at, rule_id LIMIT ?`,
      )
      .all(now, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRule(r));
  }

  /** Tasks due for a scheduler wakeup (restart recovery derives the queue from this). */
  dueTasks(now: string, limit: number): BuyerTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM buyer_tasks
         WHERE principal_id = ? AND next_run_at IS NOT NULL AND next_run_at <= ?
           AND status IN ('ready','searching','tracking')
         ORDER BY next_run_at, task_id LIMIT ?`,
      )
      .all(this.principalId, now, limit) as unknown as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  /** Tracking tasks whose expires_at passed (only tracking -> expired is legal, §11.3). */
  expirableTasks(now: string): BuyerTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM buyer_tasks
         WHERE principal_id = ? AND expires_at IS NOT NULL AND expires_at < ?
           AND status = 'tracking'`,
      )
      .all(this.principalId, now) as unknown as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  pauseRule(ruleId: string): TrackingRule {
    return this.setRuleStatus(ruleId, "paused");
  }

  completeRule(ruleId: string): TrackingRule {
    return this.setRuleStatus(ruleId, "completed");
  }

  private setRuleStatus(ruleId: string, status: TrackingRule["status"]): TrackingRule {
    const res = this.db
      .prepare("UPDATE tracking_rules SET status = ? WHERE rule_id = ?")
      .run(status, ruleId);
    if (res.changes !== 1) throw new BuyerTaskError("not_found", `no rule ${ruleId}`);
    return this.getRule(ruleId) as TrackingRule;
  }

  /** Mark a rule checked: reschedule next_check_at; record trigger time when fired. */
  markRuleChecked(ruleId: string, triggered: boolean, now: string): void {
    const rule = this.getRule(ruleId);
    if (rule === undefined) throw new BuyerTaskError("not_found", `no rule ${ruleId}`);
    const next = new Date(Date.parse(now) + rule.interval_seconds * 1000).toISOString();
    this.db
      .prepare(
        `UPDATE tracking_rules
         SET next_check_at = ?, last_triggered_at = CASE WHEN ? THEN ? ELSE last_triggered_at END
         WHERE rule_id = ?`,
      )
      .run(next, triggered ? 1 : 0, now, ruleId);
  }

  // ---- consultation links (design §11.8) -----------------------------------

  /**
   * Associate a Buyer task + candidate with an authoritative Marketplace
   * Conversation. Idempotent per (task_id, conversation_id): a retried link
   * returns the existing row instead of duplicating it.
   */
  createConsultationLink(input: {
    task_id: string;
    candidate_id?: string;
    connector_id: string;
    conversation_id: string;
    idempotency_key: string;
  }): ConsultationLink {
    const now = this.now();
    this.db.exec("BEGIN");
    try {
      if (this.eventByIdempotencyKey(input.idempotency_key) !== undefined) {
        const existing = this.db
          .prepare(
            "SELECT * FROM consultation_links WHERE task_id = ? AND conversation_id = ?",
          )
          .get(input.task_id, input.conversation_id) as Record<string, unknown> | undefined;
        this.db.exec("COMMIT");
        if (existing !== undefined) return this.rowToLink(existing);
      }
      const task = this.getTask(input.task_id);
      if (task === undefined) throw new BuyerTaskError("not_found", `no task ${input.task_id}`);
      if (input.candidate_id !== undefined) {
        const candidate = this.getCandidate(input.candidate_id);
        if (candidate === undefined || candidate.task_id !== input.task_id) {
          throw new BuyerTaskError("not_found", `no candidate ${input.candidate_id} in task`);
        }
      }
      const linkId = `link_${uuidv7()}`;
      this.db
        .prepare(
          `INSERT INTO consultation_links
             (link_id, task_id, candidate_id, connector_id, conversation_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'consulting', ?, ?)`,
        )
        .run(
          linkId,
          input.task_id,
          input.candidate_id ?? null,
          input.connector_id,
          input.conversation_id,
          now,
          now,
        );
      this.appendEventTx(
        input.task_id,
        "consultation_linked",
        { link_id: linkId, conversation_id: input.conversation_id, candidate_id: input.candidate_id ?? null },
        "model",
        input.idempotency_key,
        now,
      );
      this.db.exec("COMMIT");
      return this.getConsultationLink(linkId) as ConsultationLink;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getConsultationLink(linkId: string): ConsultationLink | undefined {
    const row = this.db
      .prepare("SELECT * FROM consultation_links WHERE link_id = ?")
      .get(linkId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.rowToLink(row);
  }

  linksForTask(taskId: string): ConsultationLink[] {
    const rows = this.db
      .prepare("SELECT * FROM consultation_links WHERE task_id = ? ORDER BY created_at, link_id")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToLink(r));
  }

  linkByConversation(conversationId: string): ConsultationLink | undefined {
    const row = this.db
      .prepare("SELECT * FROM consultation_links WHERE conversation_id = ? LIMIT 1")
      .get(conversationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.rowToLink(row);
  }

  updateConsultationLink(
    linkId: string,
    patch: { status?: ConsultationLinkStatus; last_message_id?: string | null },
  ): ConsultationLink {
    const link = this.getConsultationLink(linkId);
    if (link === undefined) throw new BuyerTaskError("not_found", `no consultation link ${linkId}`);
    this.db
      .prepare(
        `UPDATE consultation_links
         SET status = ?, last_message_id = ?, updated_at = ?
         WHERE link_id = ?`,
      )
      .run(
        patch.status ?? link.status,
        patch.last_message_id === undefined ? (link.last_message_id ?? null) : patch.last_message_id,
        this.now(),
        linkId,
      );
    return this.getConsultationLink(linkId) as ConsultationLink;
  }

  // ---- row mapping -------------------------------------------------------------

  private rowToTask(row: TaskRow): BuyerTask {
    const task: BuyerTask = {
      task_id: row.task_id,
      principal_id: row.principal_id,
      status: row.status as BuyerTaskStatus,
      goal_text: row.goal_text,
      intent: JSON.parse(row.intent_json) as TaskIntent,
      constraints: JSON.parse(row.constraints_json) as TaskConstraints,
      ranking_policy: JSON.parse(row.ranking_policy_json) as RankingPolicy,
      connector_scope: JSON.parse(row.connector_scope_json) as { connectors: string[] },
      search_budget: JSON.parse(row.search_budget_json) as SearchBudget,
      tracking_policy: JSON.parse(row.tracking_policy_json) as TrackingPolicy,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    const selected = opt(row.selected_candidate_id);
    if (selected !== undefined) task.selected_candidate_id = selected;
    const nextRun = opt(row.next_run_at);
    if (nextRun !== undefined) task.next_run_at = nextRun;
    const expires = opt(row.expires_at);
    if (expires !== undefined) task.expires_at = expires;
    return task;
  }

  private rowToEvent(row: Record<string, unknown>): TaskEvent {
    return {
      event_id: row.event_id as string,
      task_id: row.task_id as string,
      type: row.type as string,
      payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
      origin: row.origin as TaskEvent["origin"],
      idempotency_key: row.idempotency_key as string,
      created_at: row.created_at as string,
    };
  }

  private rowToCandidate(row: Record<string, unknown>): ProductCandidate {
    const c: ProductCandidate = {
      candidate_id: row.candidate_id as string,
      task_id: row.task_id as string,
      connector_id: row.connector_id as string,
      platform: row.platform as string,
      external_product_id: row.external_product_id as string,
      canonical_key: row.canonical_key as string,
      eligibility: row.eligibility as ProductCandidate["eligibility"],
      candidate_status: row.candidate_status as CandidateStatus,
      rejection_reasons: JSON.parse((row.rejection_reasons_json as string | null) ?? "[]"),
      first_seen_at: row.first_seen_at as string,
      last_seen_at: row.last_seen_at as string,
    };
    if (row.sku !== null) c.sku = row.sku as string;
    if (row.merchant_id !== null) c.merchant_id = row.merchant_id as string;
    if (row.owner_agent_id !== null) c.owner_agent_id = row.owner_agent_id as string;
    if (row.merchant_name !== null) c.merchant_name = row.merchant_name as string;
    if (row.score !== null) c.score = row.score as number;
    if (row.score_explanation_json !== null) {
      c.score_explanation = JSON.parse(row.score_explanation_json as string);
    }
    if (row.latest_observation_id !== null) {
      c.latest_observation_id = row.latest_observation_id as string;
    }
    return c;
  }

  private rowToObservation(row: Record<string, unknown>): ProductObservation {
    return {
      observation_id: row.observation_id as string,
      candidate_id: row.candidate_id as string,
      observed_at: row.observed_at as string,
      source_url_or_ref: row.source_url_or_ref as string,
      title: row.title as string,
      price: JSON.parse(row.price_json as string),
      promotion: JSON.parse(row.promotion_json as string),
      stock: JSON.parse(row.stock_json as string),
      delivery: JSON.parse(row.delivery_json as string),
      after_sales: JSON.parse(row.after_sales_json as string),
      merchant: JSON.parse(row.merchant_json as string),
      content_hash: row.content_hash as string,
      fresh_until: row.fresh_until as string,
    };
  }

  private rowToRule(row: Record<string, unknown>): TrackingRule {
    const rule: TrackingRule = {
      rule_id: row.rule_id as string,
      task_id: row.task_id as string,
      rule_type: row.rule_type as TrackingRuleType,
      condition: JSON.parse(row.condition_json as string),
      interval_seconds: row.interval_seconds as number,
      next_check_at: row.next_check_at as string,
      cooldown_seconds: row.cooldown_seconds as number,
      status: row.status as TrackingRule["status"],
    };
    if (row.candidate_id !== null) rule.candidate_id = row.candidate_id as string;
    if (row.last_triggered_at !== null) rule.last_triggered_at = row.last_triggered_at as string;
    return rule;
  }

  private rowToLink(row: Record<string, unknown>): ConsultationLink {
    const link: ConsultationLink = {
      link_id: row.link_id as string,
      task_id: row.task_id as string,
      connector_id: row.connector_id as string,
      conversation_id: row.conversation_id as string,
      status: row.status as ConsultationLinkStatus,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
    if (row.candidate_id !== null) link.candidate_id = row.candidate_id as string;
    if (row.last_message_id !== null) link.last_message_id = row.last_message_id as string;
    return link;
  }
}
