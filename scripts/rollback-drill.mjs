#!/usr/bin/env node

import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [previous, current, state] = process.argv.slice(2).map((value) => (value ? resolve(value) : ""));
if (!previous || !current || !state) {
  console.error("usage: node scripts/rollback-drill.mjs <previous-release-dir> <current-release-dir> <new-state-dir>");
  process.exit(2);
}

const verifier = fileURLToPath(new URL("./verify-release-manifest.mjs", import.meta.url));
for (const [label, directory] of [["previous", previous], ["current", current]]) {
  const result = spawnSync(process.execPath, [verifier, directory], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`rollback drill stopped: ${label} release is not verifiable`);
    process.exit(result.status ?? 1);
  }
}

mkdirSync(state, { recursive: true });
const active = resolve(state, "active");
if (existsSync(active)) {
  console.error(`rollback drill requires a new state directory; found ${active}`);
  process.exit(1);
}

symlinkSync(previous, active, "dir");
if (realpathSync(active) !== realpathSync(previous)) throw new Error("rollback to previous release failed");
console.log("rollback drill: previous release activated");

// Promote the current release again without rebuilding either release.
symlinkSync(current, active + ".restore", "dir");
if (realpathSync(active + ".restore") !== realpathSync(current)) throw new Error("restore to current release failed");
console.log("rollback drill: current release restored");
