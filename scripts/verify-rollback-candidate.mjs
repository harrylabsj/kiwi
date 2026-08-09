#!/usr/bin/env node
// Non-destructive rollback candidate verification.
//
// Usage:
//   node scripts/verify-rollback-candidate.mjs <previous-release-manifest.json>
//   node scripts/verify-rollback-candidate.mjs <previous-release-dir>
//
// Accepts either a previous release-manifest.json file directly or a previous
// release directory that contains it. It verifies that every npm / PyPI artifact
// recorded in the previous manifest still exists in the public registry and that
// the registry-served bytes match the recorded digests, then prints the previous
// release as a rollback candidate.
//
// This script NEVER deletes, unpublishes, overwrites, or mutates any registry
// artifact. It is read-only verification so an operator can pick a safe previous
// release to roll back to (a future npm/PyPI patch, never reusing a version).

import { basename, join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  downloadBuffer,
  MANIFEST_SCHEMA,
  npmRegistryMetadata,
  parseNpmTarballFilename,
  parsePyPiFilename,
  pypiMetadata,
  verifyNpmDownload,
  verifyPyPiFile,
} from "./lib/registry-verify.mjs";

const reference = resolve(process.argv[2] ?? "");
if (!reference) {
  console.error("usage: node scripts/verify-rollback-candidate.mjs <previous-release-manifest.json|dir>");
  process.exit(2);
}

let manifest;
if (statSync(reference).isDirectory()) {
  const manifestPath = join(reference, "release-manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`previous release directory ${reference} has no release-manifest.json`);
    process.exit(2);
  }
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} else {
  manifest = JSON.parse(await readFile(reference, "utf8"));
}
if (manifest.schema !== MANIFEST_SCHEMA || !Array.isArray(manifest.files)) {
  throw new Error(`unsupported previous release manifest: ${reference}`);
}

const verified = [];

// npm tarball identity is derived from the pack filename when the previous
// artifact directory is not available locally (manifest-only mode).
const npmEntry = manifest.files.find(
  (entry) => entry.path.startsWith("npm/") && entry.path.endsWith(".tgz"),
);
if (npmEntry) {
  const { name, version } = parseNpmTarballFilename(basename(npmEntry.path));
  const meta = npmRegistryMetadata(name, version);
  const buffer = await downloadBuffer(meta.tarball);
  verifyNpmDownload(buffer, {
    identity: { name, version },
    integrity: meta.integrity,
    sha256: npmEntry.sha256,
  });
  verified.push(`npm ${name}@${version} still served with matching digest`);
}

for (const pkgDir of ["kiwi-catalog", "shopping-cli"]) {
  const entries = manifest.files.filter(
    (entry) =>
      entry.path.startsWith(`${pkgDir}/`) &&
      (entry.path.endsWith(".whl") || entry.path.endsWith(".tar.gz")),
  );
  if (entries.length === 0) continue;
  const first = parsePyPiFilename(basename(entries[0].path));
  const meta = await pypiMetadata(first.name, first.version);
  for (const entry of entries) {
    const filename = basename(entry.path);
    const pypiFile = meta.urls.find((url) => url.filename === filename);
    if (!pypiFile) {
      throw new Error(
        `PyPI ${first.name}@${first.version} no longer serves ${filename} recorded in previous manifest`,
      );
    }
    const buffer = await downloadBuffer(pypiFile.url);
    verifyPyPiFile(buffer, {
      identity: { name: first.name, version: first.version, filename },
      pypiSha256: pypiFile.digests.sha256,
      manifestSha256: entry.sha256,
    });
    verified.push(`PyPI ${first.name}@${first.version} ${filename} still served with matching digest`);
  }
}

if (verified.length === 0) {
  throw new Error("previous manifest contains no registry artifacts to verify");
}

for (const line of verified) console.log(line);
console.log(`rollback candidate verified: ${verified.length} previous registry artifact(s) still match recorded digests`);
