import process from "node:process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import path from "node:path";

const options = JSON.parse(process.argv[2]);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(name) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(options.dir, name))) {
    if (Date.now() >= deadline) throw new Error(`child ${options.actor} timed out waiting for ${name}`);
    pause(5);
  }
}
function mark(stage) {
  fs.writeFileSync(path.join(options.dir, `${options.actor}.${stage}`), JSON.stringify({ actor: options.actor, pid: process.pid, stage }));
}
if (options.startDelayMs) pause(options.startDelayMs);
const { TaskApprovalStore } = await import(pathToFileURL(options.bundle).href);
mark("loaded");
waitFor(`${options.actor}.initialize`);
const original = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = original.call(this, sql);
  if (sql.includes("INSERT INTO mcp_tasks")) {
    const run = statement.run.bind(statement);
    statement.run = (...args) => {
      this.exec("PRAGMA busy_timeout=5000");
      mark("ready"); // Exactly at actual INSERT.run, before any insert effect.
      waitFor("go");
      return run(...args);
    };
  }
  return statement;
};
const store = new TaskApprovalStore({ dbPath: options.dbPath });
try {
  mark("initialized");
  waitFor("arm");
  process.stdout.write(JSON.stringify(store.createTask(options.task)));
} finally {
  store.close();
}
