/** Buyer privacy processing for append-only Negotiation Ledger payloads. */

import path from "node:path";

import { LedgerStore } from "../negotiation/ledger/store.js";
import type { PrivacyDeletionNodeHandler } from "./workbench-retention.js";

/**
 * The cloud runtime derives buyerPrincipalId and A2A sender_identity from the
 * same authenticated verifier. The ledger retains its identity envelope and
 * hash-linked event; only unshared external payloads can be physically erased.
 */
export function createLedgerPayloadDeletionHandler(options: { dir: string }): PrivacyDeletionNodeHandler {
  const dir = path.resolve(options.dir);
  return ({ requestId, buyerPrincipalId, consentGeneration }) => {
    const report = new LedgerStore({ dir }).redactPayloadsForIdentity({
      senderIdentity: buyerPrincipalId,
      redactionId: requestId,
    });
    const receiptRef =
      `negotiation-ledger:${requestId}:${consentGeneration}:` +
      `events-${report.matchedEvents}:segments-${report.redactedSegments}`;
    if (report.status === "completed") return { receiptRef };
    const limitations = report.limitations.join(",");
    return {
      receiptRef,
      status: "restricted",
      limitationReason:
        `Ledger processing remains restricted (${limitations}); ` +
        `${report.matchedEvents} events matched, ${report.redactedSegments} payload segments redacted, ` +
        `${report.inlinePayloadEvents} inline payload events and ${report.sharedSegments} shared segments remain. ` +
        "The append-only identity envelope is retained; review the retention basis and remaining scope.",
    };
  };
}
