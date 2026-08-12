#!/usr/bin/env node
// Post-publish registry download verification.
//
// Usage:
//   node scripts/verify-registry-downloads.mjs <release-dir>
//
// The release-dir must contain release-manifest.json (and the built npm
// tarball) produced by the protected portfolio release workflow. This script:
//
//   npm   - npm view <pkg>@<version> for dist.tarball + dist.integrity, download
//           the exact registry tarball, then verify its sha512 (SRI) against the
//           registry integrity field and its sha256 against the release manifest.
//   PyPI  - fetch pypi.org JSON for both Python packages, download every wheel
//           and sdist, then verify each file's sha256 against both the PyPI JSON
//           digest and the release manifest.
//
// Registry metadata alone is never trusted; the release manifest (built and
// signed locally) is the authority. Any mismatch fails closed.

import { basename, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  downloadBuffer,
  loadManifest,
  npmRegistryMetadata,
  npmTarballPackageJson,
  parsePyPiFilename,
  pypiMetadata,
  verifyNpmDownload,
  verifyPyPiFile,
} from "./lib/registry-verify.mjs";

const releaseDir = resolve(process.argv[2] ?? "release");
if (!existsSync(join(releaseDir, "release-manifest.json"))) {
  console.error(`release directory ${releaseDir} has no release-manifest.json`);
  process.exit(2);
}

const manifest = await loadManifest(releaseDir);
const verified = [];

// ---------------------------------------------------------------------------
// npm package
// ---------------------------------------------------------------------------
const npmEntry = manifest.files.find(
  (entry) => entry.path.startsWith("npm/") && entry.path.endsWith(".tgz"),
);
if (!npmEntry) {
  throw new Error("release manifest has no npm tarball entry under npm/");
}
{
  const tarballPath = join(releaseDir, npmEntry.path);
  const { name, version } = npmTarballPackageJson(tarballPath);
  const meta = await npmRegistryMetadata(name, version);
  const buffer = await downloadBuffer(meta.tarball);
  verifyNpmDownload(buffer, {
    identity: { name, version },
    integrity: meta.integrity,
    sha256: npmEntry.sha256,
  });
  verified.push(`npm ${name}@${version} verified (${meta.tarball})`);
}

// ---------------------------------------------------------------------------
// PyPI packages (kiwi-catalog and shopping-cli)
// ---------------------------------------------------------------------------
for (const pkgDir of ["kiwi-catalog", "shopping-cli"]) {
  const entries = manifest.files.filter(
    (entry) =>
      entry.path.startsWith(`${pkgDir}/`) &&
      (entry.path.endsWith(".whl") || entry.path.endsWith(".tar.gz")),
  );
  if (entries.length === 0) {
    throw new Error(`release manifest has no ${pkgDir} Python artifacts`);
  }
  const first = parsePyPiFilename(basename(entries[0].path));
  const meta = await pypiMetadata(first.name, first.version);
  for (const entry of entries) {
    const filename = basename(entry.path);
    const pypiFile = meta.urls.find((url) => url.filename === filename);
    if (!pypiFile) {
      throw new Error(
        `PyPI ${first.name}@${first.version} does not serve ${filename} (recorded in release manifest)`,
      );
    }
    const buffer = await downloadBuffer(pypiFile.url);
    verifyPyPiFile(buffer, {
      identity: { name: first.name, version: first.version, filename },
      pypiSha256: pypiFile.digests.sha256,
      manifestSha256: entry.sha256,
    });
    verified.push(`PyPI ${first.name}@${first.version} ${filename} verified (${pypiFile.url})`);
  }
}

for (const line of verified) console.log(line);
console.log(`registry downloads verified: ${verified.length} artifact(s)`);
