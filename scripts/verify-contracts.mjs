import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "contracts/manifest.json");

const fail = (message) => {
  console.error(`contract verification failed: ${message}`);
  process.exitCode = 1;
};

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.manifest_version !== 1) fail("unsupported manifest_version");
if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
  fail("contracts must be a non-empty array");
}

const ids = new Set();
const paths = new Set();
const digests = [];
for (const entry of manifest.contracts ?? []) {
  if (!entry || typeof entry.id !== "string" || typeof entry.version !== "string") {
    fail("every entry requires string id and version");
    continue;
  }
  if (ids.has(entry.id)) fail(`duplicate id ${entry.id}`);
  ids.add(entry.id);
  if (typeof entry.path !== "string" || paths.has(entry.path)) {
    fail(`invalid or duplicate path for ${entry.id}`);
    continue;
  }
  paths.add(entry.path);
  if (!entry.path.startsWith("contracts/") || entry.path.includes("..")) {
    fail(`path escapes contracts/: ${entry.path}`);
    continue;
  }
  const filePath = resolve(root, entry.path);
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch {
    fail(`missing file ${entry.path}`);
    continue;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  digests.push([entry.path, entry.sha256]);
  if (digest !== entry.sha256) {
    fail(`${entry.path} hash ${digest} does not match manifest ${entry.sha256}`);
  }
}

const discover = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await discover(absolute)));
    else if (entry.isFile() && (entry.name.endsWith(".schema.json") || entry.name === "schema.json")) {
      files.push(absolute.slice(root.length + 1));
    }
  }
  return files;
};
const discovered = new Set(await discover(resolve(root, "contracts")));
for (const path of discovered) if (!paths.has(path)) fail(`schema is missing from manifest: ${path}`);
for (const path of paths) if (!discovered.has(path)) fail(`manifest path is not a schema: ${path}`);

const bundleInput = digests
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, digest]) => `${path}\0${digest}\n`)
  .join("");
const bundleDigest = createHash("sha256").update(bundleInput).digest("hex");
if (bundleDigest !== manifest.bundle_sha256) {
  fail(`bundle hash ${bundleDigest} does not match manifest ${manifest.bundle_sha256}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`contract verification passed: ${manifest.contracts.length} entries (${bundleDigest})`);
