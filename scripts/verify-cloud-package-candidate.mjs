#!/usr/bin/env node
/** Validate all current npm shipping bytes and the actual tarball plan, not metadata equality alone. */
import { packRecord } from "./lib/npm-pack-record.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  assertBudget,
  assertSource,
  MAX_TGZ,
  json,
  npm,
  sha256,
  verifyTarball,
} from "./lib/npm-shipping.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 分阶段标记：CI 上这一步曾出现"启动后静默结束"，没有标记就无法定位死在哪一段。
const stage = (name) => process.stderr.write(`[cloud-candidate] ${name}\n`);
stage("start");
const dir = path.join(root, "build/cloud-package"),
  source = assertSource(root);
stage("source-verified");
const pkg = json(path.join(dir, "package.json")),
  manifest = json(path.join(dir, "build-manifest.json")),
  runtime = json(path.join(dir, "runtime-package.json"));
assert.equal(pkg.name, "@harrylabsj/kiwi-merchant-cloud");
assert.equal(pkg.version, "0.12.29");
assert.equal(runtime.version, pkg.version);
assert.equal(manifest.artifact_kind, "kiwi-merchant-cloud-package");
assert.equal(manifest.source_commit, source.source_commit);
assert.equal(manifest.source_contract_sha256, source.contract_sha256);
assert.deepEqual(pkg.dependencies, json(path.join(root, "package.json")).dependencies);
assert.equal(pkg.bundleDependencies, undefined, "lightweight package must not bundle dependencies");
assert.equal(pkg.bundledDependencies, undefined, "lightweight package must not bundle dependencies");
stage("metadata-verified");
stage("pack-plan-start");
const plan = packRecord(JSON.parse(npm(dir, ["pack", "--dry-run", "--json"])), {
  name: pkg.name,
  version: pkg.version,
});
const planned = plan.files
  .map((r) => r.path)
  .filter((p) => p !== "build-manifest.json")
  .sort();
assert(planned.every((p) => !p.startsWith("node_modules/")), "lightweight package must not include node_modules");
assert(planned.includes("deployment-lock.json"), "lightweight package must include deployment-lock.json");
assert(!planned.includes("package-lock.json"), "lightweight package must not carry package-lock.json");
assert(!planned.includes("npm-shrinkwrap.json"), "lightweight package must not carry npm-shrinkwrap.json");
stage("pack-plan-verified");
assert.deepEqual(planned, manifest.files.map((r) => r.path).sort(), "shipping file set mismatch");
for (const row of manifest.files) {
  const file = path.resolve(dir, row.path);
  assert(file.startsWith(dir + path.sep));
  assert.equal(statSync(file).size, row.size);
  assert.equal(sha256(readFileSync(file)), row.sha256, `changed shipping file ${row.path}`);
}
assert.equal(aggregate(manifest.files), manifest.artifact_sha256);
assert.equal(manifest.file_count, manifest.files.length);
assert.equal(assertBudget(manifest.files), manifest.total_bytes);
const lock = json(path.join(dir, "deployment-lock.json"));
assert(Number.isInteger(lock.lockfileVersion) && lock.lockfileVersion >= 3, "lockfileVersion must be >= 3");
assert.deepEqual(lock.packages[""]?.dependencies, pkg.dependencies, "lock root dependencies mismatch");
for (const [relative, row] of Object.entries(lock.packages)) {
  if (relative === "" || row.link === true) continue;
  assert(
    typeof row.integrity === "string" && row.integrity.startsWith("sha512-"),
    `lock entry missing integrity: ${relative}`,
  );
}
const rootLock = json(path.join(root, "package-lock.json")).packages;
for (const name of Object.keys(pkg.dependencies)) {
  const entry = lock.packages[`node_modules/${name}`];
  assert(entry !== undefined, `lock missing direct dependency ${name}`);
  assert.equal(entry.version, rootLock[`node_modules/${name}`]?.version, `locked version drift ${name}`);
  assert(typeof entry.integrity === "string" && entry.integrity.startsWith("sha512-"), `missing integrity ${name}`);
}
stage("lock-verified");
const tgzDir = path.join(root, "release/npm/kiwi-merchant-cloud");
if (!existsSync(tgzDir)) throw new Error("SHIPPING_ACTUAL_PACK_REQUIRED");
const tgzs = readdirSync(tgzDir).filter((p) => p.endsWith(".tgz"));
assert.equal(tgzs.length, 1);
stage("manifest-files-verified");
const tgz = path.join(tgzDir, tgzs[0]);
assert(statSync(tgz).size < MAX_TGZ, "project compressed tgz budget exceeded");
const packed = verifyTarball(readFileSync(tgz), [
  ...manifest.files,
  {
    path: "build-manifest.json",
    size: statSync(path.join(dir, "build-manifest.json")).size,
    sha256: sha256(readFileSync(path.join(dir, "build-manifest.json"))),
  },
]);
if (packed.integrity !== plan.integrity || packed.compressed_bytes !== plan.size)
  throw new Error("SHIPPING_CLOUD_PACK_SRI_MISMATCH");
stage("tarball-verified");
console.log(
  JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    source_commit: source.source_commit,
    file_count: manifest.file_count,
    plain_bytes: manifest.total_bytes,
    tgz_bytes: statSync(tgz).size,
    tgz_sha256: sha256(readFileSync(tgz)),
    actual_pack: packed,
    direct_dependencies: Object.keys(pkg.dependencies).length,
  }),
);
