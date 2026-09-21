import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { MutableServiceState } from "../src/http/merchant-management/service-state.js";

describe("persistent Workbench service safety control", () => {
  it("keeps PAUSED across process reconstruction and persists resume revision", () => {
    const db = new DatabaseSync(":memory:");
    const first = new MutableServiceState("OPERATING");
    first.attachPersistence(db, "merchant-1");
    expect(first.pause("incident response")).toEqual({ service_revision: 2 });
    expect(first.gateCheck()).toMatchObject({ accepting: false, state: "PAUSED" });

    const restarted = new MutableServiceState("OPERATING");
    restarted.attachPersistence(db, "merchant-1");
    expect(restarted.state).toBe("PAUSED");
    expect(restarted.serviceRevision).toBe(2);
    expect(restarted.resume(true, [])).toEqual({ service_revision: 3 });

    const afterResume = new MutableServiceState("OPERATING");
    afterResume.attachPersistence(db, "merchant-1");
    expect(afterResume.state).toBe("OPERATING");
    expect(afterResume.serviceRevision).toBe(3);
    db.close();
  });

  it("allows an explicit non-operating declaration only to tighten persisted OPERATING", () => {
    const db = new DatabaseSync(":memory:");
    new MutableServiceState("OPERATING").attachPersistence(db, "merchant-1");
    const declaredPaused = new MutableServiceState("PAUSED");
    declaredPaused.attachPersistence(db, "merchant-1");
    expect(declaredPaused.state).toBe("PAUSED");
    expect(declaredPaused.serviceRevision).toBe(2);

    const implicitOperating = new MutableServiceState("OPERATING");
    implicitOperating.attachPersistence(db, "merchant-1");
    expect(implicitOperating.state).toBe("PAUSED");
    expect(implicitOperating.serviceRevision).toBe(2);
    db.close();
  });
});
