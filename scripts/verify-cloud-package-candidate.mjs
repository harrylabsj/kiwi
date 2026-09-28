#!/usr/bin/env node

// Validate the generated merchant-cloud npm candidate before it enters the
// signed portfolio release bundle. No registry calls or publication occur.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cloudDir = path.join(root, "build/cloud-package");
const source = JSON.parse(readFileSync(path.join(root, "packages/merchant-cloud/package.json"), "utf8"));
const runtime = JSON.parse(readFileSync(path.join(cloudDir, "runtime-package.json"), "utf8"));
const builtPackage = JSON.parse(readFileSync(path.join(cloudDir, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(cloudDir, "build-manifest.json"), "utf8"));
assert.equal(source.name, "@harrylabsj/kiwi-merchant-cloud");
assert.equal(builtPackage.name, source.name);
assert.equal(builtPackage.version, source.version);
assert.equal(builtPackage.repository.url, "git+https://github.com/harrylabsj/kiwi.git");
assert.equal(manifest.runtime_version, source.version);
assert.equal(runtime.version, source.version);
assert.equal(manifest.artifact_kind, "kiwi-merchant-cloud-package");
assert.match(manifest.artifact_sha256, /^sha256:[a-f0-9]{64}$/);
assert(Array.isArray(manifest.files) && manifest.files.length > 0);
for (const required of ["app", "contracts", "node_modules", "index.js", "prepare.mjs"]) {
  assert(existsSync(path.join(cloudDir, required)), `cloud package missing ${required}`);
}
const packaged = readdirSync(path.join(root, "build"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name === "cloud-package");
assert.equal(packaged.length, 1);
console.log(`merchant-cloud candidate valid: ${source.name}@${source.version}; ${manifest.file_count} files; ${manifest.artifact_sha256}`);
