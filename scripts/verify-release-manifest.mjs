#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "release");
if (!isAbsolute(root)) {
  console.error("release directory must resolve to an absolute path");
  process.exit(2);
}

const fail = (message) => {
  console.error(`release verification failed: ${message}`);
  process.exitCode = 1;
};

const safePath = (relativePath) => {
  const absolute = resolve(root, relativePath);
  const escaped = relative(root, absolute).startsWith("..") || isAbsolute(relative(root, absolute));
  if (escaped) throw new Error(`path escapes release directory: ${relativePath}`);
  return absolute;
};

const sums = (await readFile(safePath("SHA256SUMS"), "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s{2}(.*)$/);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    return { sha256: match[1], path: match[2] };
  });
const manifest = JSON.parse(await readFile(safePath("release-manifest.json"), "utf8"));
if (manifest.schema !== "kiwi.portfolio.release-manifest.v1" || !Array.isArray(manifest.files)) {
  throw new Error("unsupported release manifest");
}

if (manifest.product_index !== undefined) {
  const indexPath = manifest.product_index;
  if (typeof indexPath !== "string" || indexPath !== "portfolio-release-index.json") {
    throw new Error("manifest product_index must be portfolio-release-index.json");
  }
  if (!manifest.files.some((file) => file.path === indexPath) || !sums.some((entry) => entry.path === indexPath)) {
    throw new Error("portfolio release index must be covered by SHA256SUMS and release manifest files");
  }
  const index = JSON.parse(await readFile(safePath(indexPath), "utf8"));
  const expectedIds = new Set([
    "kiwi-merchant-cloud", "kiwi", "kiwi-catalog", "shopping-cli", "kiwi-dsh-plugin", "hermes-plugin-kiwi",
    "kiwi-catalog-admin", "workbuddy-procurement-expert", "workbuddy-merchant-app",
    "workbuddy-merchant-connector", "workbuddy-kiwi-sourcing-connector",
  ]);
  if (index.schema !== "kiwi.portfolio.release-index.v1" || index.product_count !== expectedIds.size || !Array.isArray(index.products)) {
    throw new Error("unsupported or incomplete portfolio release index");
  }
  const products = new Map(index.products.map((product) => [product.id, product]));
  if (products.size !== expectedIds.size || [...expectedIds].some((id) => !products.has(id))) {
    throw new Error("portfolio release index must contain each product exactly once");
  }
  const filesByPath = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  for (const product of products.values()) {
    if (!Array.isArray(product.artifacts)) throw new Error(`${product.id}: artifacts must be an array`);
    if (product.delivery === "artifact-in-bundle" && product.artifacts.length === 0) {
      throw new Error(`${product.id}: artifact-in-bundle product has no artifacts`);
    }
    if (product.delivery === "external-reference-only" && product.artifacts.length !== 0) {
      throw new Error(`${product.id}: external-reference-only product unexpectedly includes artifacts`);
    }
    if (!new Set(["artifact-in-bundle", "external-reference-only"]).has(product.delivery)) {
      throw new Error(`${product.id}: unsupported delivery state`);
    }
    for (const artifact of product.artifacts) {
      if (filesByPath.get(artifact.path) !== artifact.sha256) {
        throw new Error(`${product.id}: artifact ${artifact.path} is missing or has a different digest in release manifest`);
      }
    }
  }
}

const sumByPath = new Map(sums.map((entry) => [entry.path, entry.sha256]));
for (const entry of manifest.files) {
  if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    fail("manifest contains an invalid file entry");
    continue;
  }
  if (sumByPath.get(entry.path) !== entry.sha256) {
    fail(`manifest/SHA256SUMS mismatch for ${entry.path}`);
    continue;
  }
  const filePath = safePath(entry.path);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) fail(`${entry.path} is not a regular file`);
  const digest = createHash("sha256").update(await readFile(filePath)).digest("hex");
  if (digest !== entry.sha256) fail(`${entry.path} digest ${digest} != ${entry.sha256}`);
}

for (const entry of sums) {
  if (!manifest.files.some((file) => file.path === entry.path)) {
    fail(`SHA256SUMS contains an unbound file: ${entry.path}`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`release manifest verified: ${manifest.files.length} files`);
