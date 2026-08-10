/**
 * Principal Memory tests (design §19.1): write governance, evidence dedup,
 * conflict/correct/supersede/forget/expiry, retrieval ordering, the Vault
 * fail-closed path, and audit hygiene (no Restricted plaintext anywhere).
 *
 * All deterministic: in-memory SQLite, injected clock, fixed test data key.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema, MEMORY_SCHEMA_VERSION } from "../src/agent/memory/schema.js";
import { MemoryStore, type RememberInput } from "../src/agent/memory/store.js";
import { MemoryError } from "../src/agent/memory/types.js";
import { EnvKeyProvider, PrivateVault, VaultKeyError } from "../src/agent/memory/vault.js";
import { buildMemoryTools } from "../src/agent/chat-tools.js";

const T0 = "2026-08-05T12:00:00+08:00";
/** Store clocks normalize to UTC ISO; assert against this form. */
const T0_UTC = new Date(Date.parse(T0)).toISOString();
const TEST_KEY = "a".repeat(64);

function setup(options: { withKey?: boolean; now?: string } = {}) {
  let clock = options.now ?? T0;
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  const vault = new PrivateVault(
    new EnvKeyProvider(options.withKey === false ? undefined : TEST_KEY),
  );
  const store = new MemoryStore({ db, vault, now: () => clock });
  store.ensurePrincipal({
    principal_id: "buyer-agent:buyer-001",
    owner_id: "buyer-001",
    role: "buyer",
  });
  store.bindPrincipal("buyer-agent:buyer-001");
  return {
    store,
    db,
    vault,
    setNow: (t: string) => {
      clock = t;
    },
  };
}

function remember(overrides: Partial<RememberInput> = {}): RememberInput {
  return {
    namespace: "preference",
    key: "shopping.promotion.preference",
    value: { kind: "free_shipping" },
    source_kind: "explicit",
    sensitivity: "normal",
    evidence: { source_type: "chat", source_ref: "session:main:1", summary: "用户说喜欢包邮" },
    explicit_user_statement: true,
    actor: "user",
    ...overrides,
  };
}

describe("schema migrations", () => {
  it("migrates a fresh database to the current version, idempotently", () => {
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    for (const t of [
      "principals",
      "memory_items",
      "memory_evidence",
      "memory_events",
      "private_vault",
      "memory_retrieval_log",
      "schema_migrations",
    ]) {
      expect(tables).toContain(t);
    }
    const v = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number;
    };
    expect(v.v).toBe(MEMORY_SCHEMA_VERSION);
    // Re-running is a no-op.
    migrateMemorySchema(db);
    db.close();
  });

  it("rolls a broken migration back completely (no partial schema)", () => {
    const db = new DatabaseSync(":memory:");
    expect(() =>
      migrateMemorySchema(
        db,
        { 1: "CREATE TABLE t1 (x TEXT);\nCREATE TABLE t1 (x TEXT);" },
        1,
      ),
    ).toThrow(/rolled back/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get()).toMatchObject({
      c: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 't1'").get(),
    ).toMatchObject({ c: 0 });
    db.close();
  });

  it("refuses to open a database newer than this build (fail closed)", () => {
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    expect(() => migrateMemorySchema(db, {}, 0)).toThrow(/newer than this build/);
    db.close();
  });
});

describe("PrivateVault", () => {
  it("seals and opens a value; the fingerprint is stable and keyed", () => {
    const vault = new PrivateVault(new EnvKeyProvider(TEST_KEY));
    const sealed = vault.seal("private_budget", "预算 200 元");
    expect(sealed.ciphertext.toString("utf8")).not.toContain("预算 200 元");
    expect(vault.open(sealed.key_version, sealed.nonce, sealed.ciphertext)).toBe("预算 200 元");
    expect(vault.fingerprint("private_budget", "预算 200 元")).toBe(sealed.value_fingerprint);
    expect(
      vault.fingerprintEquals(sealed.value_fingerprint, vault.fingerprint("private_budget", "预算 200 元")),
    ).toBe(true);
  });

  it("fails closed with no data key, with a short key, and on tampering", () => {
    const noKey = new PrivateVault(new EnvKeyProvider(undefined));
    expect(noKey.available).toBe(false);
    expect(() => noKey.seal("address", "x")).toThrow(VaultKeyError);
    expect(() => new EnvKeyProvider("short")).toThrow(VaultKeyError);

    const vault = new PrivateVault(new EnvKeyProvider(TEST_KEY));
    const sealed = vault.seal("address", "北京市海淀区xx路1号");
    const tampered = Buffer.from(sealed.ciphertext);
    tampered.writeUInt8(tampered.readUInt8(0) ^ 1, 0);
    expect(() => vault.open(sealed.key_version, sealed.nonce, tampered)).toThrow(VaultKeyError);
    const other = new PrivateVault(new EnvKeyProvider("b".repeat(64)));
    expect(() => other.open(sealed.key_version, sealed.nonce, sealed.ciphertext)).toThrow(
      VaultKeyError,
    );
  });
});

describe("principal binding", () => {
  it("creates the principal once; role/owner mismatch fails closed", () => {
    const { store } = setup();
    const again = store.ensurePrincipal({
      principal_id: "buyer-agent:buyer-001",
      owner_id: "buyer-001",
      role: "buyer",
    });
    expect(again.role).toBe("buyer");
    expect(() =>
      store.ensurePrincipal({
        principal_id: "buyer-agent:buyer-001",
        owner_id: "buyer-001",
        role: "merchant",
      }),
    ).toThrow(MemoryError);
  });
});

describe("write governance (design §10.1)", () => {
  it("an explicit user statement is active + confirmed with confidence 1.0", () => {
    const { store } = setup();
    const outcome = store.remember(remember());
    expect(outcome.kind).toBe("active");
    const memory = outcome.kind === "active" ? outcome.memory : undefined;
    expect(memory?.status).toBe("active");
    expect(memory?.confidence).toBe(1.0);
    expect(memory?.confirmed_at).toBe(T0_UTC);
    const events = store.memoryEvents(memory!.memory_id).map((e) => e.type);
    expect(events).toEqual(["memory.confirmed"]);
  });

  it("a single observed signal stays a candidate and is never retrieved as fact", () => {
    const { store } = setup();
    const outcome = store.remember(
      remember({
        source_kind: "observed",
        explicit_user_statement: false,
        evidence: { source_type: "selection", source_ref: "task:1", summary: "选择了包邮商品" },
        actor: "system",
      }),
    );
    expect(outcome.kind).toBe("candidate");
    const id = outcome.kind === "candidate" ? outcome.memory.memory_id : "";
    expect(outcome.kind === "candidate" && outcome.memory.confidence).toBe(0.5);
    expect(store.retrieve({ session_id: "main", purpose: "rank" })).toHaveLength(0);
    expect(store.memoryEvents(id).map((e) => e.type)).toEqual(["memory.proposed"]);
  });

  it("system-recorded episode memories are active and retrievable（审查 P2-G）", () => {
    const { store } = setup();
    const outcome = store.remember(
      remember({
        namespace: "episode",
        key: "a2a-negotiation:neg-001",
        source_kind: "observed",
        explicit_user_statement: false,
        actor: "system",
        value: { kind: "a2a_negotiation", negotiation_id: "neg-001" },
      }),
    );
    // 此前恒为 candidate 且无自动激活路径 → retrieve 永不返回（死功能）
    expect(outcome.kind).toBe("active");
    const memory = outcome.kind === "active" ? outcome.memory : undefined;
    expect(memory?.status).toBe("active");
    const hits = store.retrieve({ session_id: "main", purpose: "rank" });
    expect(hits.some((h) => h.memory_id === memory?.memory_id)).toBe(true);
  });

  it("model-written episode memories stay candidate（审查 P2-G fail-closed）", () => {
    const { store } = setup();
    const outcome = store.remember(
      remember({
        namespace: "episode",
        source_kind: "observed",
        explicit_user_statement: false,
        actor: "model",
        value: { kind: "a2a_negotiation", negotiation_id: "neg-002" },
      }),
    );
    expect(outcome.kind).toBe("candidate");
    expect(store.retrieve({ session_id: "main", purpose: "rank" })).toHaveLength(0);
  });

  it("three deduplicated signals activate a soft preference; repeats do not count", () => {
    const { store } = setup();
    const base = remember({
      source_kind: "observed",
      explicit_user_statement: false,
      evidence: { source_type: "selection", source_ref: "task:1", summary: "选了包邮" },
      actor: "system",
    });
    const first = store.remember(base);
    const id = first.kind === "candidate" ? first.memory.memory_id : "";

    // Same task repeated: deduplicated, no inflation.
    store.remember(base);
    let item = store.getMemory(id);
    expect(item?.evidence_count).toBe(1);
    expect(item?.status).toBe("candidate");

    // Distinct tasks: count up; at 3 the preference activates.
    store.addEvidence(id, { source_type: "selection", source_ref: "task:2", summary: "又选包邮" });
    expect(store.getMemory(id)?.status).toBe("candidate");
    store.addEvidence(id, { source_type: "selection", source_ref: "task:3", summary: "还选包邮" });
    item = store.getMemory(id);
    expect(item?.evidence_count).toBe(3);
    expect(item?.status).toBe("active");
    expect(item?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(store.memoryEvents(id).map((e) => e.type)).toContain("memory.activated");
  });

  it("inferred/observed signals can never write hard constraints", () => {
    const { store } = setup();
    expect(() =>
      store.remember(
        remember({
          namespace: "constraint",
          key: "shopping.max_total_price",
          value: { amount: 200 },
          source_kind: "inferred",
          explicit_user_statement: false,
        }),
      ),
    ).toThrow(/hard constraints require an explicit source/);
  });

  it("conflicts never silently overwrite: contradict evidence, then explicit supersede", () => {
    const { store } = setup();
    const first = store.remember(remember({ value: { kind: "free_shipping" } }));
    const firstId = first.kind === "active" ? first.memory.memory_id : "";

    const conflict = store.remember(
      remember({
        value: { kind: "small_discount" },
        source_kind: "observed",
        explicit_user_statement: false,
        evidence: { source_type: "selection", source_ref: "task:9", summary: "选了小折扣" },
        actor: "system",
      }),
    );
    expect(conflict.kind).toBe("conflict");
    expect(store.getMemory(firstId)?.value).toEqual({ kind: "free_shipping" });
    expect(store.memoryEvents(firstId).map((e) => e.type)).toContain("memory.contradicted");

    // A recent explicit statement supersedes the old memory.
    const newer = store.remember(remember({ value: { kind: "small_discount" } }));
    expect(newer.kind).toBe("active");
    expect(store.getMemory(firstId)?.status).toBe("superseded");
    expect(store.memoryEvents(firstId).map((e) => e.type)).toContain("memory.superseded");
    expect(store.retrieve({ session_id: "main", purpose: "rank" })).toHaveLength(1);
  });

  it("user correction bumps the version, marks explicit + confirmed, and audits", () => {
    const { store } = setup();
    const first = store.remember(remember({ value: { kind: "free_shipping" } }));
    const id = first.kind === "active" ? first.memory.memory_id : "";
    const corrected = store.correctMemory(
      id,
      { value: { kind: "official_store_first" } },
      "user",
      "用户澄清",
    );
    expect(corrected.version).toBe(2);
    expect(corrected.value).toEqual({ kind: "official_store_first" });
    expect(corrected.confidence).toBe(1.0);
    const events = store.memoryEvents(id);
    const correctedEvent = events.find((e) => e.type === "memory.corrected");
    expect(correctedEvent?.before_json).toMatchObject({ value: { kind: "free_shipping" } });
    expect(correctedEvent?.after_json).toMatchObject({ value: { kind: "official_store_first" } });
  });

  it("confirmMemory activates a candidate; explicit sources reach confidence 1.0", () => {
    const { store } = setup();
    const outcome = store.remember(
      remember({
        sensitivity: "private",
        source_kind: "observed",
        explicit_user_statement: false,
        evidence: { source_type: "chat", source_ref: "session:main:2", summary: "提到预算" },
        actor: "model",
      }),
    );
    expect(outcome.kind).toBe("candidate");
    const id = outcome.kind === "candidate" ? outcome.memory.memory_id : "";
    const confirmed = store.confirmMemory(id, "user");
    expect(confirmed.status).toBe("active");
    expect(confirmed.confirmed_at).toBe(T0_UTC);
    expect(store.memoryEvents(id).map((e) => e.type)).toContain("memory.confirmed");
  });
});

describe("Restricted values and the Vault", () => {
  it("fails closed without a data key", () => {
    const { store } = setup({ withKey: false });
    expect(() =>
      store.remember(
        remember({
          namespace: "profile",
          key: "contact.address.home",
          sensitivity: "restricted",
          restricted: { kind: "address", plaintext: "北京市海淀区xx路1号" },
          value: undefined,
        }),
      ),
    ).toThrow(/fail closed|no data key/);
  });

  it("stores Restricted values only in the Vault; no plaintext anywhere in the DB", () => {
    const { store, db } = setup();
    const secret = "北京市海淀区xx路1号";
    const outcome = store.remember(
      remember({
        namespace: "profile",
        key: "contact.address.home",
        sensitivity: "restricted",
        restricted: { kind: "address", plaintext: secret },
        value: undefined,
      }),
    );
    // Restricted values can never auto-activate from a model remember call:
    // they stay candidate until the human /confirms them (design §10.1/§16).
    expect(outcome.kind).toBe("candidate");
    const memory = outcome.kind === "candidate" ? outcome.memory : undefined;
    expect(memory?.vault_ref).toMatch(/^vr_/);
    expect(memory?.value).toBeUndefined();

    // The whole database is free of the plaintext.
    const dump = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[])
      .map((t) => {
        const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
        return JSON.stringify(rows, (k, v) => (v instanceof Uint8Array ? "<blob>" : v));
      })
      .join("\n");
    expect(dump).not.toContain(secret);

    // Human confirmation promotes to active; retrieval serves metadata only.
    const confirmed = store.confirmMemory(memory!.memory_id, "user");
    expect(confirmed.status).toBe("active");
    const retrieved = store.retrieve({ session_id: "main", purpose: "clarify" });
    expect(retrieved[0]?.redaction_level).toBe("metadata_only");
    expect(retrieved[0]?.value).toBeUndefined();
    expect(store.openVaultValue(memory!.vault_ref as string)).toBe(secret);
    expect(store.vaultEntries()).toHaveLength(1);
  });

  it("requires an explicit source and statement for Restricted memories", () => {
    const { store } = setup();
    expect(() =>
      store.remember(
        remember({
          namespace: "profile",
          key: "contact.address.home",
          sensitivity: "restricted",
          restricted: { kind: "address", plaintext: "x" },
          value: undefined,
          source_kind: "inferred",
          explicit_user_statement: false,
        }),
      ),
    ).toThrow(/explicit/);
  });

  it("forgetting a Restricted memory erases its Vault ciphertext", () => {
    const { store } = setup();
    const secret = "上海市静安区yy路2号";
    const outcome = store.remember(
      remember({
        namespace: "profile",
        key: "contact.address.work",
        sensitivity: "restricted",
        restricted: { kind: "address", plaintext: secret },
        value: undefined,
      }),
    );
    const memory = outcome.kind === "candidate" ? outcome.memory : undefined;
    store.forgetMemory(memory!.memory_id, "user", "用户要求删除");
    expect(store.vaultEntries()).toHaveLength(0);
    expect(store.retrieve({ session_id: "main", purpose: "clarify" })).toHaveLength(0);
    expect(store.memoryEvents(memory!.memory_id).map((e) => e.type)).toContain("memory.forgotten");
  });
});

describe("human-confirmation gate and sensitivity escalation (P0)", () => {
  it("constraint memories stay candidate until the human /confirms them", () => {
    const { store } = setup();
    const outcome = store.remember(
      remember({
        namespace: "constraint",
        key: "shopping.budget.max",
        value: { max: 500 },
        explicit_user_statement: true,
      }),
    );
    expect(outcome.kind).toBe("candidate");
    const id = outcome.kind === "candidate" ? outcome.memory.memory_id : "";
    // A candidate is not trusted context yet.
    expect(store.retrieve({ session_id: "main", purpose: "rank" })).toHaveLength(0);
    const confirmed = store.confirmMemory(id, "user");
    expect(confirmed.status).toBe("active");
    expect(store.retrieve({ session_id: "main", purpose: "rank" })).toHaveLength(1);
  });

  it("restricted plaintext never echoes into evidence summaries or audit events", () => {
    const { store, db } = setup();
    const secret = "北京市朝阳区zz路9号";
    store.remember(
      remember({
        namespace: "profile",
        key: "contact.address.delivery",
        sensitivity: "restricted",
        restricted: { kind: "address", plaintext: secret },
        value: undefined,
        evidence: {
          source_type: "chat",
          source_ref: "session:main:2",
          summary: `用户家庭地址：${secret}，注意保护`,
        },
      }),
    );
    const dump = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[])
      .map((t) => {
        const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
        return JSON.stringify(rows, (k, v) => (v instanceof Uint8Array ? "<blob>" : v));
      })
      .join("\n");
    expect(dump).not.toContain(secret);
  });

  it("escalates precise personal-data strings to the Vault regardless of claimed sensitivity", () => {
    const { store, db } = setup();
    const secret = "我家住在北京市海淀区xx路1号";
    const outcome = store.remember(
      remember({
        namespace: "profile",
        key: "contact.address.home",
        value: secret,
        sensitivity: "normal",
        explicit_user_statement: true,
      }),
    );
    // Escalated to restricted -> candidate until the human confirms.
    expect(outcome.kind).toBe("candidate");
    const memory = outcome.kind === "candidate" ? outcome.memory : undefined;
    expect(memory?.vault_ref).toMatch(/^vr_/);
    expect(memory?.value).toBeUndefined();
    const dump = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[])
      .map((t) => {
        const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
        return JSON.stringify(rows, (k, v) => (v instanceof Uint8Array ? "<blob>" : v));
      })
      .join("\n");
    expect(dump).not.toContain("海淀区");
    const confirmed = store.confirmMemory(memory!.memory_id, "user");
    expect(confirmed.sensitivity).toBe("restricted");
    expect(store.retrieve({ session_id: "main", purpose: "rank" })[0]?.redaction_level).toBe("metadata_only");
  });

  it("refuses an escalated sensitive value without an explicit user statement (fail closed)", () => {
    const { store } = setup();
    expect(() =>
      store.remember(
        remember({
          namespace: "profile",
          key: "contact.address.home",
          value: "电话 13800001111",
          explicit_user_statement: false,
          source_kind: "observed",
        }),
      ),
    ).toThrow(/explicit/);
  });

  it("does not escalate ordinary preference strings", () => {
    const { store } = setup();
    const outcome = store.remember(remember({ value: "偏好京东自营", sensitivity: "normal" }));
    expect(outcome.kind).toBe("active");
    const memory = outcome.kind === "active" ? outcome.memory : undefined;
    expect(memory?.sensitivity).toBe("normal");
    expect(memory?.value).toBe("偏好京东自营");
  });
});

describe("retrieval (design §10.3)", () => {
  it("orders by confidence × source × scope deterministically and logs redaction", () => {
    const { store } = setup();
    // Explicit, confirmed, global, high confidence.
    store.remember(remember({ key: "shopping.promotion.preference", value: { kind: "包邮优先" } }));
    // Inferred, lower confidence — activate via evidence so it is retrievable.
    const inferred = store.remember(
      remember({
        key: "shopping.brand.preference",
        value: { kind: "自营优先" },
        source_kind: "observed",
        explicit_user_statement: false,
        evidence: { source_type: "selection", source_ref: "task:1", summary: "选自营" },
        actor: "system",
      }),
    );
    const inferredId = inferred.kind === "candidate" ? inferred.memory.memory_id : "";
    for (const ref of ["task:2", "task:3"]) {
      store.addEvidence(inferredId, { source_type: "selection", source_ref: ref, summary: "又选自营" });
    }

    const results = store.retrieve({
      session_id: "main",
      purpose: "rank",
      text: "包邮 促销 偏好",
    });
    expect(results.length).toBe(2);
    expect(results[0]?.key).toBe("shopping.promotion.preference");
    expect(results[0]?.score ?? 0).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[0]?.redaction_level).toBe("full");

    const log = store.retrievalLog("main");
    expect(log).toHaveLength(2);
    expect(log.map((l) => l.memory_id)).toEqual(results.map((r) => r.memory_id));
    expect(log.every((l) => l.purpose === "rank")).toBe(true);
  });

  it("scope matching: a category-matched memory outranks a global one; contradictions lose", () => {
    const { store } = setup();
    store.remember(
      remember({ key: "shopping.promotion.global", value: { kind: "包邮优先" } }),
    );
    store.remember(
      remember({
        key: "shopping.promotion.preference",
        value: { kind: "生鲜次日达" },
        scope: { category: "fresh" },
      }),
    );
    const scoped = store.retrieve({
      session_id: "main",
      purpose: "rank",
      scopes: [{ category: "fresh" }],
    });
    expect(scoped[0]?.key).toBe("shopping.promotion.preference");
    // An unrelated category query drops the scoped memory's advantage.
    const other = store.retrieve({
      session_id: "main",
      purpose: "rank",
      scopes: [{ category: "electronics" }],
    });
    expect(other[0]?.key).toBe("shopping.promotion.global");
  });

  it("task_context memories are only visible to their own task", () => {
    const { store } = setup();
    store.remember(
      remember({
        namespace: "task_context",
        key: "gift.this_time",
        value: { note: "这次送礼" },
        scope: { task_id: "task_1" },
      }),
    );
    expect(store.retrieve({ session_id: "main", purpose: "rank" })).toHaveLength(0);
    expect(
      store.retrieve({ session_id: "main", purpose: "rank", task_id: "task_2" }),
    ).toHaveLength(0);
    expect(
      store.retrieve({ session_id: "main", purpose: "rank", task_id: "task_1" }),
    ).toHaveLength(1);
  });

  it("expired items leave retrieval and produce an audit event", () => {
    const { store, setNow } = setup();
    const outcome = store.remember(
      remember({ expires_at: "2026-08-06T00:00:00+08:00" }),
    );
    const id = outcome.kind === "active" ? outcome.memory.memory_id : "";
    expect(store.retrieve({ session_id: "main", purpose: "rank" })).toHaveLength(1);
    setNow("2026-08-07T00:00:00+08:00");
    expect(store.retrieve({ session_id: "main", purpose: "rank" })).toHaveLength(0);
    expect(store.memoryEvents(id).map((e) => e.type)).toContain("memory.expired");
  });

  it("/why explains the last retrieval with memory ids and redaction levels", () => {
    const { store } = setup();
    const outcome = store.remember(remember());
    const id = outcome.kind === "active" ? outcome.memory.memory_id : "";
    store.retrieve({ session_id: "main", purpose: "explain", text: "包邮" });
    const why = store.explainLastRetrieval("main");
    expect(why.entries).toHaveLength(1);
    expect(why.entries[0]).toMatchObject({
      memory_id: id,
      key: "shopping.promotion.preference",
      redaction_level: "full",
      purpose: "explain",
    });
  });
});

describe("listings", () => {
  it("lists memories by namespace/sensitivity without Restricted values", () => {
    const { store } = setup();
    store.remember(remember());
    store.remember(
      remember({
        namespace: "profile",
        key: "contact.address.home",
        sensitivity: "restricted",
        restricted: { kind: "address", plaintext: "秘密地址" },
        value: undefined,
      }),
    );
    expect(store.listMemories({ namespace: "preference" })).toHaveLength(1);
    const privates = store.listMemories({ sensitivity: "restricted" });
    expect(privates).toHaveLength(1);
    expect(JSON.stringify(privates)).not.toContain("秘密地址");
  });
});

describe("P2: expiry timezone, evidence dedup and shared Vault refs", () => {
  it("a +08:00 expires_at expires at the correct UTC instant", () => {
    const { store, setNow } = setup();
    store.remember(remember({ expires_at: "2026-08-06T00:00:00+08:00" })); // = 08-05T16:00Z
    expect(store.retrieve({ session_id: "main", purpose: "rank" })).toHaveLength(1);
    setNow("2026-08-05T16:30:00.000Z"); // past the true 16:00Z expiry
    expect(store.retrieve({ session_id: "main", purpose: "rank" })).toHaveLength(0);
  });

  it("two remember calls in the same turn add only one evidence piece", async () => {
    const { store } = setup();
    const turn = { current: "session:main:1" };
    const tools = buildMemoryTools(store, { turnId: () => turn.current });
    const rememberTool = tools.find((t) => t.name === "remember");
    expect(rememberTool).toBeDefined();
    const params = {
      namespace: "preference",
      key: "shopping.note.x",
      value: "喜欢京东自营",
      sensitivity: "normal",
      source_kind: "explicit",
      explicit_user_statement: true,
      reason_summary: "用户陈述",
    };
    await rememberTool!.execute("c1", params, undefined, undefined, undefined);
    await rememberTool!.execute("c2", params, undefined, undefined, undefined);
    expect(store.listMemories({})[0]?.evidence_count).toBe(1);
    // A later turn counts as a distinct evidence window.
    turn.current = "session:main:2";
    await rememberTool!.execute("c3", params, undefined, undefined, undefined);
    expect(store.listMemories({})[0]?.evidence_count).toBe(2);
  });

  it("the model cannot forget/correct a hard constraint (human-only)", async () => {
    const { store } = setup();
    const outcome = store.remember(
      remember({
        namespace: "constraint",
        key: "shopping.budget.max",
        value: { max: 1 },
        explicit_user_statement: true,
      }),
    );
    const id = outcome.kind === "candidate" ? outcome.memory.memory_id : "";
    const tools = buildMemoryTools(store);
    const forget = tools.find((t) => t.name === "forget_memory");
    const correct = tools.find((t) => t.name === "correct_memory");
    const f = await forget!.execute("c1", { memory_id: id }, undefined, undefined, undefined);
    expect((f.content[0] as { type: "text"; text: string }).text).toContain("/forget");
    expect(store.getMemory(id)?.status).not.toBe("deleted");
    const c = await correct!.execute("c2", { memory_id: id, value: { max: 2 } }, undefined, undefined, undefined);
    expect((c.content[0] as { type: "text"; text: string }).text).toContain("/correct");
    expect(store.getMemory(id)?.value).toEqual({ max: 1 });
  });

  it("records the current memory schema version on the principal", () => {
    const { store } = setup();
    const p = store.getPrincipal("buyer-agent:buyer-001");
    expect(p?.memory_schema_version).toBe(MEMORY_SCHEMA_VERSION);
  });

  it("forgetting one shared-Vault memory keeps the ciphertext for the other", () => {
    const { store } = setup();
    const secret = "上海市静安区yy路9号";
    const a = store.remember(
      remember({
        namespace: "profile",
        key: "contact.address.home",
        sensitivity: "restricted",
        restricted: { kind: "address", plaintext: secret },
        value: undefined,
      }),
    );
    const b = store.remember(
      remember({
        namespace: "profile",
        key: "contact.address.work",
        sensitivity: "restricted",
        restricted: { kind: "address", plaintext: secret },
        value: undefined,
      }),
    );
    const aId = a.kind === "candidate" ? a.memory.memory_id : "";
    const bId = b.kind === "candidate" ? b.memory.memory_id : "";
    const ref = b.kind === "candidate" ? b.memory.vault_ref : undefined;
    expect(ref).toBeDefined();
    // Same plaintext -> fingerprint-deduped to one vault row.
    expect(store.vaultEntries()).toHaveLength(1);
    store.forgetMemory(aId, "user", "test");
    // b still references it: the ciphertext survives.
    expect(store.vaultEntries()).toHaveLength(1);
    expect(store.openVaultValue(ref as string)).toBe(secret);
    store.forgetMemory(bId, "user", "test");
    expect(store.vaultEntries()).toHaveLength(0);
  });
});
