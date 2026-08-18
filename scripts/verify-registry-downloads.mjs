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
  isFreshPublish,
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
  // 本 run 幂等跳过的版本：registry 上是历史构建，不与新 manifest 比字节，
  // 只校验 registry 自身 integrity（防替换）；真实发布的版本严格对比。
  const fresh = isFreshPublish(process.env.VERIFY_FRESH_NPM);
  verifyNpmDownload(buffer, {
    identity: { name, version },
    integrity: meta.integrity,
    sha256: fresh ? npmEntry.sha256 : undefined,
  });
  verified.push(
    `npm ${name}@${version} verified (${meta.tarball})${fresh ? "" : " [registry digest only: predates this run]"}`,
  );
}

// ---------------------------------------------------------------------------
// dsh-plugin npm package (@harrylabsj/kiwi-dsh-plugin)
// ---------------------------------------------------------------------------
const dshEntry = manifest.files.find(
  (entry) => entry.path.startsWith("dsh-plugin/") && entry.path.endsWith(".tgz"),
);
if (!dshEntry) {
  throw new Error("release manifest has no dsh-plugin npm tarball entry under dsh-plugin/");
}
{
  const tarballPath = join(releaseDir, dshEntry.path);
  const { name, version } = npmTarballPackageJson(tarballPath);
  const meta = await npmRegistryMetadata(name, version);
  const buffer = await downloadBuffer(meta.tarball);
  const fresh = isFreshPublish(process.env.VERIFY_FRESH_DSH_PLUGIN);
  verifyNpmDownload(buffer, {
    identity: { name, version },
    integrity: meta.integrity,
    sha256: fresh ? dshEntry.sha256 : undefined,
  });
  verified.push(
    `npm ${name}@${version} verified (${meta.tarball})${fresh ? "" : " [registry digest only: predates this run]"}`,
  );
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
  // 同 npm：幂等跳过的版本只校验 PyPI 自身 digests，不与新 manifest 比字节。
  const freshEnv =
    pkgDir === "kiwi-catalog" ? process.env.VERIFY_FRESH_KIWI_CATALOG : process.env.VERIFY_FRESH_SHOPPING_CLI;
  const fresh = isFreshPublish(freshEnv);
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
      manifestSha256: fresh ? entry.sha256 : undefined,
    });
    verified.push(
      `PyPI ${first.name}@${first.version} ${filename} verified (${pypiFile.url})${fresh ? "" : " [registry digest only: predates this run]"}`,
    );
  }
}

for (const line of verified) console.log(line);
console.log(`registry downloads verified: ${verified.length} artifact(s)`);
