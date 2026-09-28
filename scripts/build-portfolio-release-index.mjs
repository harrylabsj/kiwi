#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_IDS = [
  "kiwi-merchant-cloud", "kiwi", "kiwi-catalog", "shopping-cli", "kiwi-dsh-plugin", "hermes-plugin-kiwi",
  "kiwi-catalog-admin", "workbuddy-procurement-expert", "workbuddy-merchant-app",
  "workbuddy-merchant-connector", "workbuddy-kiwi-sourcing-connector",
];

async function listFiles(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative.split(path.sep).join("/"), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`release tree contains symlink: ${child}`);
    if (entry.isDirectory()) result.push(...await listFiles(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

function patternFor(product) {
  const artifact = product.artifact;
  if (artifact === null) return null;
  assert.equal(typeof artifact, "string", `${product.id}: artifact must be a path pattern or null`);
  assert(artifact.startsWith("release/"), `${product.id}: artifact must be rooted under release/`);
  const relative = artifact.slice("release/".length);
  const escaped = relative.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

function sourceRepository(product) {
  if (product.repository) return product.repository;
  if (product.version_source?.scope === "central") return "harrylabsj/kiwi";
  if (product.version_source?.scope === "consumer") return `harrylabsj/${product.id}`;
  return null;
}

/**
 * @param {{ catalog: any, releaseDir: string }} options
 * @returns {Promise<any>}
 */
export async function buildPortfolioReleaseIndex({ catalog, releaseDir }) {
  assert.equal(catalog.schema, "kiwi.portfolio.products.v1", "unsupported product catalog schema");
  assert.equal(catalog.products.length, EXPECTED_IDS.length, "portfolio must enumerate all eleven products");
  assert.deepEqual(catalog.products.map((product) => product.id).sort(), [...EXPECTED_IDS].sort());
  const allFiles = await listFiles(releaseDir);
  const products = [];

  for (const product of catalog.products) {
    const pattern = patternFor(product);
    const matched = pattern === null ? [] : allFiles.filter((file) => pattern.test(file)).sort();
    if (pattern !== null && matched.length === 0) {
      throw new Error(`${product.id}: artifact pattern matched no files: ${product.artifact}`);
    }
    const artifacts = [];
    for (const file of matched) {
      const bytes = await readFile(path.join(releaseDir, file));
      artifacts.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    const externalOnly = artifacts.length === 0;
    if (externalOnly && typeof product.bundle_reason !== "string") {
      throw new Error(`${product.id}: artifact is external-only but bundle_reason is missing`);
    }
    products.push({
      id: product.id,
      name: product.name,
      version: product.version,
      channel: product.channel,
      state: product.state,
      release_controller: product.release_controller,
      repository: sourceRepository(product),
      source: product.source ?? null,
      source_commit: product.source_commit ?? null,
      version_source: product.version_source,
      external_version_evidence: product.external_version_evidence ?? null,
      requires: product.requires ?? [],
      gates: product.gates ?? [],
      bundle_reason: product.bundle_reason ?? null,
      platform_asset_id: product.platform_asset_id ?? null,
      platform_live_version: product.platform_live_version ?? null,
      pinned_runtime_version: product.pinned_runtime_version ?? null,
      delivery: externalOnly ? "external-reference-only" : "artifact-in-bundle",
      artifacts,
    });
  }

  return {
    schema: "kiwi.portfolio.release-index.v1",
    snapshot_date: catalog.snapshot_date,
    product_count: products.length,
    products,
  };
}

async function main() {
  const [catalogArg, releaseArg, outputArg] = process.argv.slice(2);
  if (!catalogArg || !releaseArg || !outputArg) {
    console.error("usage: node scripts/build-portfolio-release-index.mjs <portfolio-products.json> <release-dir> <output.json>");
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const catalogPath = path.resolve(root, catalogArg);
  const releaseDir = path.resolve(root, releaseArg);
  const outputPath = path.resolve(root, outputArg);
  const releaseRelative = path.relative(releaseDir, outputPath);
  if (releaseRelative.startsWith("..") || path.isAbsolute(releaseRelative)) {
    throw new Error("release index output must be inside release directory");
  }
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const index = await buildPortfolioReleaseIndex({ catalog, releaseDir });
  await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`portfolio release index built: ${index.product_count} products; ${index.products.filter((product) => product.delivery === "artifact-in-bundle").length} with bundled artifacts`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
