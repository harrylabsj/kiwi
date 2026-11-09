import { chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// npm bin targets need an executable bit even when tsc emits 0644.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "dist", "workbuddy-adapter", "cli.js");
if (!existsSync(target)) {
  process.stderr.write(`missing build output: ${target}\n`);
  process.exit(1);
}
chmodSync(target, 0o755);
