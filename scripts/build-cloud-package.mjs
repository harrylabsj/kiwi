#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.join(root, "build", "cloud-artifact");
const out = path.join(root, "build", "cloud-package");
const sourcePackage = path.join(root, "packages", "merchant-cloud");
const manifestPath = path.join(artifact, "artifact-manifest.json");
if (!existsSync(manifestPath) || !existsSync(path.join(artifact, "node_modules"))) throw new Error("云端制品不存在；先运行 node scripts/build-cloud-artifact.mjs");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of ["app", "contracts", "node_modules", "index.js"]) cpSync(path.join(artifact, name), path.join(out, name), { recursive: true });
cpSync(path.join(artifact, "package.json"), path.join(out, "runtime-package.json"));
cpSync(path.join(sourcePackage, "prepare.mjs"), path.join(out, "prepare.mjs"));
const pkg = JSON.parse(readFileSync(path.join(sourcePackage, "package.json"), "utf8"));
const artifactPkg = JSON.parse(readFileSync(path.join(artifact, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
pkg.version = manifest.runtime_version;
const shippedDependencies = Object.fromEntries(
  Object.entries(artifactPkg.dependencies ?? {}).filter(([name]) =>
    existsSync(path.join(artifact, "node_modules", name, "package.json")),
  ),
);
pkg.dependencies = shippedDependencies;
pkg.bundleDependencies = Object.keys(shippedDependencies).sort();
pkg.bundledDependencies = pkg.bundleDependencies;
writeFileSync(path.join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

// 本地 smoke fixture；生产商家需替换身份、商品表和策略文件。
mkdirSync(path.join(out, "app", "cloud-sample"), { recursive: true });
const merchant = "merchant-001";
writeFileSync(path.join(out, "app", "cloud-sample", "merchant.yaml"), [
  "# 本地冒烟夹具；生产商家必须替换 profile 和商品数据。",
  "runtime_version: 0.6.0", "protocol_version: shopping.negotiation/0.1", `agent_id: merchant-agent:${merchant}`,
  'name: "Kiwi A2A Merchant"',
  "role: merchant", `owner_id: ${merchant}`, "commerce:", "  base_url: http://127.0.0.1:1",
  "  token_env: KIWI_PILOT_COMMERCE_TOKEN", "  backend: local_marketplace", "  allow_demo_price_fallback: false",
  "model:", "  provider: fake", "  model: fake-merchant-model", "runtime:", "  mode: once", "  poll_interval_seconds: 5",
  "  turn_timeout_seconds: 90", "  max_model_steps: 4", "  max_retries: 2", "merchant_policy:",
  "  min_unit_price_private: 80.00", "  max_auto_discount_percent: 10", "  inventory_source: marketplace",
  "  quote_ttl_seconds: 300", "  auto_negotiate: true", "",
].join("\n"));
writeFileSync(path.join(out, "app", "cloud-sample", "products.json"), `${JSON.stringify({
  schema_version: "0.1.2", merchant_id: merchant, source: "test_fixture", generated_at: new Date().toISOString(),
  products: [{ sku: "smoke-sku-1", title: "Local smoke fixture", currency: "CNY", unit: "piece", price: 120, moq: 1,
    supply_note: "Local smoke fixture only", updated_at: new Date().toISOString(),
    valid_until: new Date(Date.now() + 7 * 86_400_000).toISOString(), status: "active", stock: 5, test: true }],
}, null, 2)}\n`);

function listFiles(dir, prefix = "") {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (relative === "node_modules/.bin" || relative === "node_modules/.package-lock.json") continue;
    if (statSync(file).isDirectory()) entries.push(...listFiles(file, relative));
    else if (name !== "build-manifest.json") entries.push({ path: relative, file });
  }
  return entries;
}
// Cover every file that will ship in npm pack, including bundled dependencies,
// package metadata, prepare logic, and the explicitly test-only pilot fixture.
const packageManifestFiles = listFiles(out)
  .map(({ path: relative, file }) => ({
    path: relative,
    size: statSync(file).size,
    sha256: `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`,
  }))
  .sort((a, b) => a.path.localeCompare(b.path));
const packageDigestLines = packageManifestFiles.map((item) => `${item.path}\0${item.sha256}`).sort().join("\n");
const packageManifest = {
  schema_version: "0.1.2",
  artifact_kind: "kiwi-merchant-cloud-package",
  runtime_version: manifest.runtime_version,
  source_commit: manifest.source_commit,
  source_artifact_sha256: manifest.artifact_sha256,
  artifact_sha256: `sha256:${createHash("sha256").update(packageDigestLines).digest("hex")}`,
  files: packageManifestFiles,
  file_count: packageManifestFiles.length,
  total_bytes: packageManifestFiles.reduce((sum, item) => sum + item.size, 0),
  notes: ["artifact_sha256 covers every npm package file except build-manifest.json itself; source_artifact_sha256 binds the original cloud artifact."],
};
writeFileSync(path.join(out, "build-manifest.json"), `${JSON.stringify(packageManifest, null, 2)}\n`);
process.stdout.write(`[cloud-package] staging ready: ${out}\n`);
