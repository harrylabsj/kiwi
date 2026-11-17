#!/usr/bin/env node
/**
 * 校验 64 条试点证据文件（M5）。
 *
 * 用法：
 *   node scripts/verify-pilot-evidence.mjs docs/kiwi/evidence/top1-3-pilot-evidence.json
 *
 * 退出码：0 = 所有 passed 记录可追溯且 64 条齐全（pending 允许）；1 = 有缺失
 * 或 passed 记录缺证据。需先 `npm run build`。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const {
  EVIDENCE_CASE_IDS,
  summarizeEvidence,
  validateEvidenceRecord,
} = await import("../dist/merchant-core/operations-jobs/pilot-evidence.js");

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: node scripts/verify-pilot-evidence.mjs <evidence.json>");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(resolve(path), "utf8"));
const records = Array.isArray(raw) ? raw : raw.records;
if (!Array.isArray(records)) {
  console.error("evidence file must contain a records array");
  process.exit(2);
}

let invalid = 0;
for (const record of records) {
  try {
    validateEvidenceRecord(record);
  } catch (err) {
    invalid += 1;
    console.error(`invalid ${record?.case_id ?? "<unknown>"}: ${err.message}`);
  }
}
const summary = summarizeEvidence(records);
const unknown = records
  .map((record) => record.case_id)
  .filter((id) => !EVIDENCE_CASE_IDS.includes(id));
for (const id of unknown) console.error(`unknown case id: ${id}`);

console.log(JSON.stringify({ summary, invalid, unknown }, null, 2));
process.exit(invalid === 0 && unknown.length === 0 && summary.missing.length === 0 ? 0 : 1);
