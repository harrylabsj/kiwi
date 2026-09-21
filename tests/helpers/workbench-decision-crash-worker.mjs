import { readFileSync } from "node:fs";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { WorkbenchConfirmationStore } from "../../dist/http/merchant-management/webauthn-confirmation.js";

const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const db = new DatabaseSync(payload.dbPath);
const store = new WorkbenchConfirmationStore({ db, now: () => payload.now });

db.function("kill_decision_process", () => {
  process.kill(process.pid, "SIGKILL");
});
db.exec(`
  CREATE TEMP TRIGGER kill_during_decision
  BEFORE INSERT ON workbench_approval_operations
  BEGIN
    SELECT kill_decision_process();
  END;
`);

store.finalizeDecision(payload.input);
db.close();
process.exitCode = 2;
