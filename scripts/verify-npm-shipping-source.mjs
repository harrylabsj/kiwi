#!/usr/bin/env node
/** Runs the existing full verify unchanged, then records this run's compilation/process evidence. */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  publishBuildReceipt,
  assertSource,
  distInventory,
  npm,
  MAX_MS,
  sha256,
} from "./lib/npm-shipping.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = assertSource(root),
  started = Date.now(),
  file = path.join(root, "build/npm-shipping-build-receipt.json");
if (existsSync(file)) throw new Error("SHIPPING_NEW_BUILD_RECEIPT_REQUIRED");
mkdirSync(path.join(root, "build"), { recursive: true });
let output;
try {
  output = npm(root, ["run", "verify"], MAX_MS);
} catch (error) {
  writeFileSync(
    path.join(root, "build/npm-shipping-fullverify.log"),
    String(error.stdout ?? "") + String(error.stderr ?? ""),
  );
  throw error; // no receipt, no rebuild, no expected mutation
}
writeFileSync(path.join(root, "build/npm-shipping-fullverify.log"), output);
assertSource(root);
const receipt = {
  format: "kiwi-npm-shipping-build-receipt/1",
  source,
  started_at_ms: started,
  finished_at_ms: Date.now(),
  verification: {
    command: ["npm", "run", "verify"],
    exit_code: 0,
    output_sha256: sha256(Buffer.from(output)),
    compiler_command: "tsc -p tsconfig.build.json",
    compiler_entry_sha256: sha256(readFileSync(path.join(root, "node_modules/typescript/bin/tsc"))),
  },
  dist: distInventory(root),
  note: "Process evidence from successful unchanged fullverify, not a mathematical compilation proof or external authority.",
};
publishBuildReceipt(file, receipt);
process.stdout.write(output);
console.log(
  JSON.stringify({
    receipt: "build/npm-shipping-build-receipt.json",
    source_commit: source.source_commit,
    dist_files: receipt.dist.length,
  }),
);
