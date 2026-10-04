/**
 * Read-only local authority adapter. Trust is established by a local host's
 * explicit file/source configuration, not by a receipt's self-declared label.
 * The owner never writes this file. An unconfigured or ambiguous source stays
 * unknown; production connectors need their own independently trusted reader.
 */
import { readFileSync } from "node:fs";
import type { ReconciliationVerifier } from "./owner-session.js";

export function createOwnerReceiptVerifier(input: {
  readonly receiptFile: string;
  readonly source: string;
}): ReconciliationVerifier {
  if (
    typeof input.receiptFile !== "string" ||
    input.receiptFile.length === 0 ||
    typeof input.source !== "string" ||
    input.source.length === 0
  )
    throw new TypeError("authority file and source required");
  const { receiptFile, source } = input;
  return Object.freeze({
    source,
    query(binding: Parameters<NonNullable<ReconciliationVerifier["query"]>>[0]) {
      const unknown = { ...binding, source, receiptRef: "", outcome: "unknown" as const };
      try {
        const records: unknown = JSON.parse(readFileSync(receiptFile, "utf8"));
        if (!Array.isArray(records)) return unknown;
        const found = records.filter((r: unknown) => {
          if (r === null || typeof r !== "object") return false;
          const row = r as Record<string, unknown>;
          return (
            row.source === source &&
            row.operationId === binding.operationId &&
            row.merchantId === binding.merchantId &&
            row.principal === binding.principal &&
            row.businessKey === binding.businessKey
          );
        });
        if (found.length !== 1) return unknown;
        const row = found[0] as Record<string, unknown>;
        if (
          typeof row.receiptRef !== "string" ||
          row.receiptRef.length === 0 ||
          (row.outcome !== "confirmed_applied" && row.outcome !== "confirmed_not_applied")
        )
          return unknown;
        return Object.freeze({
          ...binding,
          source,
          receiptRef: row.receiptRef,
          outcome: row.outcome,
        });
      } catch {
        return unknown;
      }
    },
  });
}
