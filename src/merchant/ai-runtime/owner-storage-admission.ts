/** A220 local host provenance. JSON is not a capability; registry records are MAC-bound. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
// Context is a Chord type (imported separately below).
export interface OwnerStorageBinding {
  storageRoot: string;
  merchantId: string;
  principal: string;
}
declare const admissionBrand: unique symbol;
export interface OwnerStorageAdmission {
  readonly [admissionBrand]: true;
}
interface Registration {
  version: 1;
  sdk: "1.0.2";
  dir: string;
  merchantId: string;
  principal: string;
  conversationId: number;
  documentId: number;
  sessionId: string;
}
interface State {
  binding: OwnerStorageBinding;
  dir: string;
  file: string;
  keyFile: string;
  registry: string;
  init: boolean;
  consumed: boolean;
  dev: number;
  ino: number;
  registration?: Registration;
}
const capabilities = new WeakMap<object, State>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class OwnerStorageAdmissionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function deny(code: string): never {
  throw new OwnerStorageAdmissionError(code);
}

function paths(binding: OwnerStorageBinding) {
  if (
    typeof binding?.merchantId !== "string" ||
    !binding.merchantId ||
    typeof binding.principal !== "string" ||
    !binding.principal
  )
    deny("storage_binding_invalid");
  const dir = resolve(
    binding.storageRoot,
    "merchants",
    createHash("sha256").update(binding.merchantId).digest("hex"),
  );
  const host = resolve(binding.storageRoot, ".owner-host");
  return {
    dir,
    file: join(dir, "session.sqlite"),
    keyFile: join(host, "registry-key"),
    registry: join(dir, "storage-origin.json"),
    host,
  };
}
function privateFile(file: string) {
  const s = lstatSync(file);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    (s.mode & 0o777) !== 0o600 ||
    (process.getuid !== undefined && s.uid !== process.getuid())
  )
    deny("storage_file_permissions");
  return s;
}
function privateDir(dir: string) {
  const s = lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700)
    deny("storage_directory_permissions");
}
function state(cap: OwnerStorageAdmission): State {
  const s = capabilities.get(cap);
  if (s === undefined) deny("storage_capability_required");
  return s;
}
function checkFile(s: State) {
  privateDir(s.dir);
  const f = privateFile(s.file);
  if (f.dev !== s.dev || f.ino !== s.ino) deny("storage_file_replaced");
  // SQLite owns sidecar lifecycle. Validate current metadata only: never
  // remove, chmod, or pin sidecar inodes across normal checkpoint/reopen.
  for (const suffix of ["-wal", "-shm"]) {
    try {
      privateFile(s.file + suffix);
    } catch (error) {
      if ((error as { code?: string })?.code === "ENOENT") continue;
      if (error instanceof OwnerStorageAdmissionError) deny("storage_sidecar_permissions");
      throw error;
    }
  }
}
function key(s: State) {
  privateDir(resolve(s.keyFile, ".."));
  privateFile(s.keyFile);
  const k = readFileSync(s.keyFile);
  if (k.length !== 32) deny("storage_registry_unknown");
  return k;
}
function mac(s: State, r: Registration) {
  return createHmac("sha256", key(s)).update(JSON.stringify(r)).digest("hex");
}
function loadRegistration(s: State): Registration {
  privateFile(s.registry);
  const raw = JSON.parse(readFileSync(s.registry, "utf8")) as {
    registration: Registration;
    mac: string;
  };
  const r = raw.registration;
  if (
    r?.version !== 1 ||
    r.sdk !== "1.0.2" ||
    r.dir !== realpathSync(s.dir) ||
    r.merchantId !== s.binding.merchantId ||
    r.principal !== s.binding.principal ||
    typeof raw.mac !== "string"
  )
    deny("storage_origin_unknown");
  const actual = Buffer.from(mac(s, r), "hex"),
    provided = Buffer.from(raw.mac, "hex");
  if (actual.length !== provided.length || !timingSafeEqual(actual, provided))
    deny("storage_origin_unknown");
  return r;
}
/** A controlled host call; refuses pre-existing files. No SDK import/open/migration here. */
export function prepareNewOwnerStorage(binding: OwnerStorageBinding): OwnerStorageAdmission {
  const p = paths(binding);
  if (existsSync(p.dir) && readdirSync(p.dir).length !== 0) deny("storage_not_new");
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  privateDir(p.dir);
  mkdirSync(p.host, { recursive: true, mode: 0o700 });
  privateDir(p.host);
  if (!existsSync(p.keyFile)) {
    const fd = openSync(p.keyFile, "wx", 0o600);
    try {
      writeFileSync(fd, randomBytes(32));
    } finally {
      closeSync(fd);
    }
  }
  const fd = openSync(p.file, "wx", 0o600);
  closeSync(fd);
  try {
    writeFileSync(join(p.dir, "operations.json"), JSON.stringify({ operations: {} }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    unlinkSync(p.file);
    throw error;
  }
  const f = privateFile(p.file);
  const s: State = {
    binding: { ...binding },
    ...p,
    init: true,
    consumed: false,
    dev: f.dev,
    ino: f.ino,
  };
  key(s);
  const cap = Object.freeze({}) as OwnerStorageAdmission;
  capabilities.set(cap, s);
  return cap;
}
/** Existing source must already carry a protected authentic host registry, not caller JSON. */
export function openRegisteredOwnerStorage(binding: OwnerStorageBinding): OwnerStorageAdmission {
  const p = paths(binding);
  privateDir(p.dir);
  const f = privateFile(p.file);
  const s: State = {
    binding: { ...binding },
    ...p,
    init: false,
    consumed: true,
    dev: f.dev,
    ino: f.ino,
  };
  s.registration = loadRegistration(s);
  readProvider(s);
  const cap = Object.freeze({}) as OwnerStorageAdmission;
  capabilities.set(cap, s);
  return cap;
}
function readProvider(s: State): Registration {
  checkFile(s);
  const r = s.registration;
  if (r === undefined) deny("storage_not_initialized");
  // Read-only, schema1/latest immutable ProviderDoc; never SDK.initialize/migrate.
  const db = new DatabaseSync(s.file, { readOnly: true });
  try {
    const schema = db.prepare("SELECT version FROM durable_schema").get() as
      { version: number } | undefined;
    if (schema?.version !== 1) deny("storage_schema_unknown");
    const conversations = db.prepare("SELECT record FROM conversations").all() as {
      record: string;
    }[];
    if (conversations.length !== 1 || JSON.parse(conversations[0]!.record).id !== r.conversationId)
      deny("storage_fork_unsupported");
    const documents = db
      .prepare(
        "SELECT id,record FROM documents WHERE retired_at IS NULL AND json_extract(record,'$.kind')='pi.provider'",
      )
      .all() as { id: number; record: string }[];
    if (documents.length !== 1 || documents[0]!.id !== r.documentId) deny("provider_doc_missing");
    const record = JSON.parse(documents[0]!.record);
    if (
      record.scope?.kind !== "conversation" ||
      record.scope.conversationId !== r.conversationId ||
      record.history !== "latest" ||
      record.fork !== "initial"
    )
      deny("provider_scope_invalid");
    const row = db
      .prepare(
        "SELECT kind,version,content FROM document_revisions WHERE document_id=? ORDER BY seq DESC LIMIT 1",
      )
      .get(r.documentId) as { kind: string; version: number; content: string } | undefined;
    if (row?.kind !== "base" || row.version !== 1) deny("provider_doc_invalid");
    const value = JSON.parse(row.content) as { sessionId?: unknown };
    if (
      typeof value.sessionId !== "string" ||
      !UUID.test(value.sessionId) ||
      value.sessionId !== r.sessionId
    )
      deny("provider_uuid_invalid");
    const tasks = db.prepare("SELECT record FROM tasks").all() as { record: string }[];
    for (const task of tasks) {
      const cp = JSON.parse(task.record).state?.checkpoint;
      if (cp?.phase === "poll" || cp?.streamOptions?.deferred) deny("storage_deferred_unsupported");
    }
    return r;
  } finally {
    db.close();
  }
}
export function assertOwnerStorageAdmission(
  cap: OwnerStorageAdmission | undefined,
  binding: OwnerStorageBinding,
) {
  if (cap === undefined) deny("storage_capability_required");
  const s = state(cap);
  if (
    s.dir !== paths(binding).dir ||
    s.binding.merchantId !== binding.merchantId ||
    s.binding.principal !== binding.principal
  )
    deny("storage_binding_mismatch");
  checkFile(s);
  if (s.init && !s.consumed) {
    if (lstatSync(s.file).size !== 0) deny("storage_new_file_changed");
  } else {
    s.registration = loadRegistration(s);
    readProvider(s);
  }
}
export function requireOwnerProvider(cap: OwnerStorageAdmission, conversationId?: number) {
  const s = state(cap);
  s.registration = loadRegistration(s);
  const r = readProvider(s);
  if (conversationId !== undefined && conversationId !== r.conversationId)
    deny("provider_conversation_mismatch");
  return r;
}
function register(s: State, w: Extract<StorageWrite, { type: "document.create" }>) {
  const v = w.content.value as { sessionId?: unknown };
  if (
    typeof v.sessionId !== "string" ||
    !UUID.test(v.sessionId) ||
    w.record.scope.kind !== "conversation"
  )
    deny("provider_doc_invalid");
  const r: Registration = {
    version: 1,
    sdk: "1.0.2",
    dir: realpathSync(s.dir),
    merchantId: s.binding.merchantId,
    principal: s.binding.principal,
    conversationId: w.record.scope.conversationId,
    documentId: w.record.id,
    sessionId: v.sessionId,
  };
  s.registration = r;
  readProvider(s);
  writeFileSync(s.registry, JSON.stringify({ registration: r, mac: mac(s, r) }), {
    flag: "wx",
    mode: 0o600,
  });
  s.init = false;
}
/** Public Storage delegation. Denies unexpected ProviderDoc creation BEFORE forward commit. */
export function guardOwnerStorage(storage: Storage, cap: OwnerStorageAdmission): Storage {
  const s = state(cap);
  const commit = storage.commit.bind(storage);
  return new Proxy(storage, {
    get(target, property) {
      if (property === "commit")
        return async (
          writes: readonly StorageWrite[],
          context: import("@earendil-works/chord").Context,
        ) => {
          const creates = writes.filter(
            (w): w is Extract<StorageWrite, { type: "document.create" }> =>
              w.type === "document.create" && w.record.kind === "pi.provider",
          );
          const init = creates[0];
          if (creates.length) {
            if (
              !s.init ||
              s.consumed ||
              creates.length !== 1 ||
              init === undefined ||
              init.record.scope.kind !== "conversation"
            )
              deny("provider_autorepair_forbidden");
            const initializationConversation = init.record.scope.conversationId;
            // Version-specific private owner contract: SDK reserved root is1.
            if (initializationConversation !== 1) deny("storage_root_required");
            if (
              !writes.some(
                (w) =>
                  w.type === "conversation" &&
                  w.value.id === initializationConversation &&
                  w.value.parent === undefined,
              )
            )
              deny("storage_init_batch_invalid");
            s.consumed = true;
          }
          for (const w of writes) {
            if (
              w.type === "conversation" &&
              (w.value.parent !== undefined ||
                w.value.id !==
                  (init && init.record.scope.kind === "conversation"
                    ? init.record.scope.conversationId
                    : s.registration?.conversationId))
            )
              deny("storage_fork_unsupported");
            if (w.type === "document.copy" && w.record.kind === "pi.provider")
              deny("provider_immutable");
            if (
              (w.type === "document.change" || w.type === "document.retire") &&
              w.id === s.registration?.documentId
            )
              deny("provider_immutable");
            if (w.type === "task") {
              const cp =
                w.value.state.status === "terminal"
                  ? undefined
                  : (w.value.state.checkpoint as {
                      phase?: string;
                      streamOptions?: { deferred?: unknown };
                    });
              if (cp?.phase === "poll" || cp?.streamOptions?.deferred)
                deny("storage_deferred_unsupported");
            }
          }
          const result = await commit(writes, context);
          if (init !== undefined) register(s, init);
          return result;
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Captured binding recheck immediately before SDK initialization/openTasks. */
export function assertOwnerStorageReady(cap: OwnerStorageAdmission) {
  const s = state(cap);
  assertOwnerStorageAdmission(cap, s.binding);
}
