import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BuyerProtocolRecovery } from "../src/buyer-core/protocol-recovery.js";
import { contentDigest } from "../src/negotiation/jcs.js";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "protocol-recovery-isolation-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const context = {
  taskId: "task-isolation",
  createdAt: "2026-11-03T00:00:00.000Z",
  intentBindingDigest: "intent-digest",
};
const merchantId = "merchant-isolation";

function slotFor(buyerId: string): string {
  return `buyer-op-${contentDigest([buyerId, context.taskId, "rfq", 0, merchantId])}`;
}

describe("BuyerProtocolRecovery operation lookup isolation", () => {
  it("does not let one buyer's in-flight operation affect another buyer", () => {
    const dir = temp();
    const buyerA = new BuyerProtocolRecovery(dir, "buyer-a");
    buyerA.idempotency.markInFlight({
      sender_identity: "buyer-a",
      message_id: slotFor("buyer-a"),
      digest: "binding-a",
    });

    expect(buyerA.hasOperation(context, "rfq", 0, merchantId)).toBe(true);

    const buyerB = new BuyerProtocolRecovery(dir, "buyer-b");
    expect(buyerB.hasOperation(context, "rfq", 0, merchantId)).toBe(false);
  });

  it("does not let one merchant's operation affect another merchant for the same buyer", () => {
    const dir = temp();
    const buyer = new BuyerProtocolRecovery(dir, "buyer-a");
    buyer.idempotency.markInFlight({
      sender_identity: "buyer-a",
      message_id: slotFor("buyer-a"),
      digest: "binding-a",
    });

    expect(buyer.hasOperation(context, "rfq", 0, "merchant-other")).toBe(false);
  });
});
