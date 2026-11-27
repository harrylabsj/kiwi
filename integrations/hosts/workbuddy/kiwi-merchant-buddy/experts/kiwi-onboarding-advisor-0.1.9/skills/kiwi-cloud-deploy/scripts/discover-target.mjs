#!/usr/bin/env node
import { resolveUpgradeTarget } from "./resolve-upgrade-target.mjs";

const [workspace, appId, origin, ...extra] = process.argv.slice(2);
try {
  if (extra.length) throw new Error("UNEXPECTED_TARGET_ARGUMENTS");
  const target = resolveUpgradeTarget({ workspace, appId, origin });
  process.stdout.write(`${JSON.stringify(target, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`[discover-target] ${error.message}\n`);
  process.exitCode = 1;
}
