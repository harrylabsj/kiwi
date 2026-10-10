import process from "node:process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const opts = JSON.parse(process.argv[2]);
const io = Object.fromEntries(
  [
    "openSync",
    "closeSync",
    "writeSync",
    "readFileSync",
    "existsSync",
    "unlinkSync",
    "appendFileSync",
    "renameSync",
  ].map((k) => [k, fs[k].bind(fs)]),
);
const fdPaths = new Map();
let entered = false,
  pausedUnlink = false,
  waitingReported = false;
function log(event, extra = {}) {
  io.appendFileSync(
    opts.events,
    JSON.stringify({ actor: opts.actor, event, at: Date.now(), ...extra }) + "\n",
  );
}
function pause(label) {
  log("barrier", { label });
  const end = Date.now() + 8000;
  while (!io.existsSync(opts.release)) {
    if (Date.now() > end) throw new Error("CHILD_BARRIER_TIMEOUT");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
fs.openSync = (p, ...args) => {
  try {
    const fd = io.openSync(p, ...args);
    fdPaths.set(fd, String(p));
    if (String(p) === opts.guard) {
      log("guard-acquired");
      if (opts.mode === "guard-crash") pause("guard-crash");
    }
    return fd;
  } catch (e) {
    if (String(p) === opts.guard && e.code === "EEXIST" && !waitingReported) {
      waitingReported = true;
      log("guard-blocked");
    }
    throw e;
  }
};
fs.closeSync = (fd) => {
  fdPaths.delete(fd);
  return io.closeSync(fd);
};
fs.writeSync = (fd, ...args) => {
  if (opts.mode === "guard-write-fault" && fdPaths.get(fd) === opts.guard)
    throw new Error("GUARD_WRITE_FAULT");
  if (opts.mode === "main-write-fault" && fdPaths.get(fd) === opts.lock)
    throw new Error("MAIN_WRITE_FAULT");
  return io.writeSync(fd, ...args);
};
fs.unlinkSync = (p) => {
  if (String(p) === opts.lock) {
    log("main-unlink");
    if (!pausedUnlink && ["reclaim-pause", "release-pause"].includes(opts.mode)) {
      pausedUnlink = true;
      pause("main-unlink");
    }
  }
  const result = io.unlinkSync(p);
  if (String(p) === opts.lock && opts.mode === "reclaim-gap" && !pausedUnlink) {
    pausedUnlink = true;
    pause("reclaim-gap");
  }
  return result;
};
fs.existsSync = (p) => {
  if (String(p) === opts.ledger && !entered) {
    entered = true;
    log("fn-enter", { guardPresent: io.existsSync(opts.guard) });
    if (opts.mode === "fn-pause") pause("fn");
    if (["cleanup-success", "cleanup-error"].includes(opts.mode)) {
      io.appendFileSync(opts.guard, "unknown guard");
      if (opts.mode === "cleanup-error") throw new Error("ORIGINAL_FN_FAULT");
    }
  }
  return io.existsSync(p);
};
fs.renameSync = (from, to) => {
  const r = io.renameSync(from, to);
  if (String(to) === opts.ledger) log("fn-exit");
  return r;
};
if (opts.killError)
  process.kill = () => {
    const e = new Error(opts.killError);
    e.code = opts.killError;
    throw e;
  };
syncBuiltinESMExports();
try {
  const { LedgerStore } = await import(opts.bundle);
  const store = new LedgerStore({ dir: opts.dir, lockTimeoutMs: opts.timeout ?? 1500 });
  const result = store.append({
    event_kind: "message_received",
    negotiation_id: opts.neg,
    message_id: "message-" + opts.actor,
    identity: {
      sender_identity: "buyer@test",
      counterparty_identity: "merchant@test",
      actor: "buyer",
    },
    capability: { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" },
    wire_digest: "sha256:" + "a".repeat(64),
    outcome: { kind: "ok", result: { actor: opts.actor } },
    occurred_at: "2026-10-08T00:00:00Z",
  });
  log("result", { ok: true, eventId: result.event_id });
} catch (e) {
  log("result", { ok: false, code: e.code, message: e.message });
  process.exitCode = 2;
}
