#!/usr/bin/env node
/** Package only the approved current-source full shipping stage; historical artifacts are refused. */
import { packRecord } from "./lib/npm-pack-record.mjs";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  assertBudget,
  assertFiles,
  assertSource,
  json,
  npm,
  sha256,
} from "./lib/npm-shipping.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.join(root, "build/cloud-artifact"),
  out = path.join(root, "build/cloud-package");
const source = assertSource(root),
  stage = json(path.join(artifact, "artifact-manifest.json"));
if (
  stage.artifact_kind !== "kiwi-npm-shipping-stage" ||
  stage.source_commit !== source.source_commit ||
  stage.source_contract_sha256 !== source.contract_sha256
)
  throw new Error("SHIPPING_CURRENT_STAGE_REQUIRED");
assertFiles(artifact, stage, { excluded: ["artifact-manifest.json"] });
if (existsSync(out)) throw new Error("SHIPPING_NEW_PACKAGE_OUTPUT_REQUIRED");
mkdirSync(out, { recursive: true });
for (const name of [
  "app",
  "contracts",
  "node_modules",
  "index.js",
  "scripts",
  "shipping-source.json",
  "shipping-sbom.cdx.json",
])
  cpSync(path.join(artifact, name), path.join(out, name), {
    recursive: true,
    verbatimSymlinks: true,
  });
cpSync(path.join(artifact, "package.json"), path.join(out, "runtime-package.json"));
cpSync(path.join(root, "packages/merchant-cloud/prepare.mjs"), path.join(out, "prepare.mjs"));
const pkg = json(path.join(root, "packages/merchant-cloud/package.json")),
  runtime = json(path.join(artifact, "package.json"));
for (const key of [
  "dependencies",
  "engines",
  "packageManager",
  "devEngines",
  "allowScripts",
])
  pkg[key] = runtime[key];
pkg.bundleDependencies = Object.keys(pkg.dependencies).sort();
pkg.bundledDependencies = pkg.bundleDependencies;
writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
// 本地 smoke fixture；生产商家需替换身份、商品表和策略文件。
mkdirSync(path.join(out, "app", "cloud-sample"), { recursive: true });
const merchant = "merchant-001";
writeFileSync(
  path.join(out, "app", "cloud-sample", "merchant.yaml"),
  [
    "# 本地冒烟夹具；生产商家必须替换 profile 和商品数据。",
    "runtime_version: 0.6.0",
    "protocol_version: shopping.negotiation/0.1",
    `agent_id: merchant-agent:${merchant}`,
    'name: "Kiwi A2A Merchant"',
    "role: merchant",
    `owner_id: ${merchant}`,
    "commerce:",
    "  base_url: http://127.0.0.1:1",
    "  token_env: KIWI_PILOT_COMMERCE_TOKEN",
    "  backend: local_marketplace",
    "  allow_demo_price_fallback: false",
    "model:",
    "  provider: fake",
    "  model: fake-merchant-model",
    "runtime:",
    "  mode: once",
    "  poll_interval_seconds: 5",
    "  turn_timeout_seconds: 90",
    "  max_model_steps: 4",
    "  max_retries: 2",
    "merchant_policy:",
    "  min_unit_price_private: 80.00",
    "  max_auto_discount_percent: 10",
    "  inventory_source: marketplace",
    "  quote_ttl_seconds: 300",
    "  auto_negotiate: true",
    "",
  ].join("\n"),
);
writeFileSync(
  path.join(out, "app", "cloud-sample", "products.json"),
  `${JSON.stringify(
    {
      schema_version: "0.1.2",
      merchant_id: merchant,
      source: "test_fixture",
      generated_at: new Date().toISOString(),
      products: [
        {
          sku: "smoke-sku-1",
          title: "Local smoke fixture",
          currency: "CNY",
          unit: "piece",
          price: 120,
          moq: 1,
          supply_note: "Local smoke fixture only",
          updated_at: new Date().toISOString(),
          valid_until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          status: "active",
          stock: 5,
          test: true,
        },
      ],
    },
    null,
    2,
  )}\n`,
);

// Normal npm pack defines the exact bundle set. No custom vendor pruning/exclusion.
const plan = packRecord(JSON.parse(npm(out, ["pack", "--dry-run", "--json"])), {
  name: pkg.name,
  version: pkg.version,
});
if (plan.name !== pkg.name || plan.version !== pkg.version)
  throw new Error("SHIPPING_PACK_PLAN_MISMATCH");
const files = plan.files
  .filter((r) => r.path !== "build-manifest.json")
  .map((r) => {
    const file = path.resolve(out, r.path);
    if (!file.startsWith(out + path.sep) || !statSync(file).isFile())
      throw new Error("SHIPPING_PACK_FILE_INVALID");
    return { path: r.path, size: statSync(file).size, sha256: sha256(readFileSync(file)) };
  })
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const total = assertBudget(files);
const manifest = {
  schema_version: "0.1.2",
  artifact_kind: "kiwi-merchant-cloud-package",
  runtime_version: pkg.version,
  source_commit: source.source_commit,
  source_artifact_sha256: stage.artifact_sha256,
  source_contract_sha256: source.contract_sha256,
  artifact_sha256: aggregate(files),
  files,
  file_count: files.length,
  total_bytes: total,
  notes: [
    "Complete normal npm bundle plan, every shipped file byte except build-manifest itself; no SDK pruning. Project tgz budget <100000000, not an npmjs official limit.",
  ],
};
writeFileSync(path.join(out, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `[cloud-package] current full shipping package ready: ${pkg.name}@${pkg.version}; ${files.length} files; ${total} plain bytes`,
);
