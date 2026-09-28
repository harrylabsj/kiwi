#!/usr/bin/env node
/**
 * Validate the portfolio's eleven-product release catalog and its version sources.
 * Consumer and public external checkouts can be supplied by the release job.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(path.join(root, "portfolio-products.json"), "utf8"));
const SHA40 = /^[a-f0-9]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXPECTED_IDS = [
  "kiwi-merchant-cloud", "kiwi", "kiwi-catalog", "shopping-cli", "kiwi-dsh-plugin", "hermes-plugin-kiwi",
  "kiwi-catalog-admin", "workbuddy-procurement-expert", "workbuddy-merchant-app",
  "workbuddy-merchant-connector", "workbuddy-kiwi-sourcing-connector",
];

function parseArgs(argv) {
  const options = { hermesRoot: "", requireExternal: false, githubOutput: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--require-external") {
      options.requireExternal = true;
      continue;
    }
    if (!["--hermes-root", "--github-output"].includes(arg) || argv[i + 1] === undefined) {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
    options[arg === "--hermes-root" ? "hermesRoot" : "githubOutput"] = argv[++i];
  }
  return options;
}

function readVersion(product, source, hermesRoot) {
  let type = source.type;
  let sourcePath;
  if (type.startsWith("external-")) {
    if (product.id !== "hermes-plugin-kiwi" || !hermesRoot) return null;
    sourcePath = path.resolve(hermesRoot, source.path);
    type = type.slice("external-".length);
  } else {
    sourcePath = path.resolve(root, source.path);
    if (!sourcePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`${product.id}: version source escapes repository root`);
    }
  }
  if (!existsSync(sourcePath)) return null;
  const raw = readFileSync(sourcePath, "utf8");
  if (type === "json") {
    let value = JSON.parse(raw);
    for (const segment of source.field.split(".")) value = value?.[segment];
    return value;
  }
  if (type === "toml") return /^version\s*=\s*["']([^"']+)["']\s*$/m.exec(raw)?.[1] ?? null;
  throw new Error(`${product.id}: unsupported version source ${type}`);
}

const options = parseArgs(process.argv.slice(2));
assert.equal(catalog.schema, "kiwi.portfolio.products.v1", "unsupported product catalog schema");
assert.equal(catalog.products.length, EXPECTED_IDS.length, "portfolio must enumerate all eleven product forms");
const ids = new Set();
const validated = [];
const deferred = [];
for (const product of catalog.products) {
  assert(product && typeof product.id === "string", "every product needs an id");
  assert(!ids.has(product.id), `duplicate product id ${product.id}`);
  assert(SEMVER.test(product.version), `${product.id}: invalid SemVer ${product.version}`);
  assert(typeof product.channel === "string" && product.channel.length > 0, `${product.id}: release channel missing`);
  ids.add(product.id);
  if (product.source_commit !== undefined) {
    assert(SHA40.test(product.source_commit), `${product.id}: source_commit must be a full SHA`);
  }
  if (product.version_source === null) {
    assert(typeof product.external_version_evidence === "string", `${product.id}: external version evidence missing`);
    continue;
  }
  const current = readVersion(product, product.version_source, options.hermesRoot);
  if (current === null) {
    if (options.requireExternal && product.version_source.scope === "hermes") {
      throw new Error(`${product.id}: required Hermes source checkout is missing`);
    }
    deferred.push(product.id);
    continue;
  }
  assert.equal(current, product.version, `${product.id}: manifest ${product.version} != source ${current}`);
  validated.push(product.id);
}
assert.deepEqual(ids, new Set(EXPECTED_IDS), "portfolio product ids differ from the registered 11-product set");

const hermes = catalog.products.find((product) => product.id === "hermes-plugin-kiwi");
if (options.hermesRoot) {
  const head = execFileSync("git", ["-C", options.hermesRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(head, hermes.source_commit, "Hermes checkout SHA differs from portfolio pin");
}
if (options.githubOutput) {
  writeFileSync(options.githubOutput, `hermes_plugin_sha=${hermes.source_commit}\n`, { flag: "a" });
}

console.log(`portfolio product catalog valid: ${ids.size} products; ${validated.length} source versions verified${deferred.length ? `; deferred checkouts: ${deferred.join(", ")}` : ""}`);
