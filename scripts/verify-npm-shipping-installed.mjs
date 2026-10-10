#!/usr/bin/env node
/** Cold normal npm12 production installs of the two exact local tarballs. No registry publication/provider/model operation. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSource,
  assertRootReceipt,
  json,
  MAX_HOST,
  MAX_MS,
  inventory,
  npm,
  sha256,
} from "./lib/npm-shipping.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = assertSource(root),
  receipt = assertRootReceipt(root, source);
const out = path.join(root, "build/npm-shipping-cold-install");
if (existsSync(out)) throw new Error("SHIPPING_NEW_COLD_INSTALL_REQUIRED");
const remaining = () => {
  const ms = MAX_MS - (Date.now() - receipt.started_at_ms);
  if (ms <= 0) throw new Error("SHIPPING_BUILD_TIMEOUT");
  return ms;
};
const hostRoot = process.env.KIWI_SHIPPING_HOST_ROOT ?? root;
const budget = () => {
  if (inventory(hostRoot).reduce((n, r) => n + r.size, 0) > MAX_HOST)
    throw new Error("SHIPPING_HOST_BUDGET");
};
budget();
mkdirSync(out, { recursive: true });
const results = [];
for (const [name, relative, subdir, app] of [
  ["@harrylabsj/kiwi", "release/npm", "root", "dist"],
  ["@harrylabsj/kiwi-merchant-cloud", "release/npm/kiwi-merchant-cloud", "cloud", "app"],
]) {
  const candidates = readdirSync(path.join(root, relative)).filter((n) => n.endsWith(".tgz"));
  if (candidates.length !== 1) throw new Error("SHIPPING_EXACT_COLD_TARBALL_REQUIRED");
  const tgz = path.join(root, relative, candidates[0]),
    consumer = path.join(out, subdir);
  mkdirSync(consumer);
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify(
      {
        name: `kiwi-shipping-cold-${subdir}`,
        version: "1.0.0",
        private: true,
        type: "module",
        overrides: json(path.join(root, "package.json")).overrides,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(path.join(consumer, ".npmrc"), "engine-strict=true\n");
  writeFileSync(
    path.join(consumer, "install.log"),
    npm(consumer, ["install", tgz, "--omit=dev"], remaining()),
  );
  const installed = path.join(consumer, "node_modules", name);
  if (json(path.join(installed, "package.json")).version !== "0.12.4")
    throw new Error("SHIPPING_COLD_VERSION_MISMATCH");
  const probe = execFileSync(
    process.execPath,
    [
      ...process.execArgv,
      path.join(root, "scripts/verify-npm-shipping-runtime.mjs"),
      installed,
      app,
    ],
    {
      cwd: consumer,
      env: { ...process.env, KIWI_OWNER_SESSION_ENABLED: "0", KIWI_AI_RUNTIME_ENABLED: "0" },
      encoding: "utf8",
      timeout: remaining(),
      maxBuffer: 32 * 1048576,
    },
  );
  writeFileSync(path.join(consumer, "runtime.log"), probe);
  if (subdir === "root") {
    const help = execFileSync(
      process.execPath,
      [...process.execArgv, path.join(installed, "dist/cli.js"), "--help"],
      {
        cwd: consumer,
        env: { ...process.env, KIWI_OWNER_SESSION_ENABLED: "0", KIWI_AI_RUNTIME_ENABLED: "0" },
        encoding: "utf8",
        timeout: remaining(),
      },
    );
    if (!help.includes("kiwi")) throw new Error("SHIPPING_CLI_HELP_MISSING");
    writeFileSync(path.join(consumer, "cli-help.log"), help);
  }
  const audit = npm(consumer, ["audit", "--omit=dev", "--json"], remaining());
  writeFileSync(path.join(consumer, "audit.json"), audit);
  budget();
  results.push({
    name,
    version: "0.12.4",
    source_commit: source.source_commit,
    tgz_sha256: sha256(readFileSync(tgz)),
    runtime_log_sha256: sha256(Buffer.from(probe)),
    normal_npm12_install: true,
    conservative_consumer_override_applied: true,
  });
}
writeFileSync(
  path.join(out, "receipt.json"),
  JSON.stringify({ source, results, no_production_or_provider_calls: true }, null, 2) + "\n",
);
console.log(
  JSON.stringify({ cold_install_receipt: "build/npm-shipping-cold-install/receipt.json", results }),
);
