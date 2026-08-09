#!/usr/bin/env node
// Shared registry download verification for the protected portfolio release
// workflow.
//
// The release pipeline never trusts registry metadata alone. Every npm / PyPI
// artifact recorded in release-manifest.json is re-downloaded from the public
// registry and its bytes are compared against:
//   1. the registry's own integrity digest (npm dist.integrity / PyPI
//      digests.sha256), which guards against a swapped registry response, and
//   2. the SHA256 recorded in the just-built release manifest, which proves the
//      registry serves exactly the bytes that were built and signed locally.
// Any mismatch is fail-closed (thrown) so the workflow stops before promotion.
//
// The pure helpers are exported so unit tests can cover path/identity parsing
// and digest verification without touching the network.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const MANIFEST_SCHEMA = "kiwi.portfolio.release-manifest.v1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Hex-encoded SHA-256 of a Buffer. */
export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Base64-encoded SHA-512 of a Buffer (npm SRI body without the sha512- prefix). */
export function sha512Base64(buffer) {
  return createHash("sha512").update(buffer).digest("base64");
}

/** Load and structurally validate a release-manifest.json from a release dir. */
export async function loadManifest(releaseDir) {
  const manifestPath = join(releaseDir, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schema !== MANIFEST_SCHEMA || !Array.isArray(manifest.files)) {
    throw new Error(`unsupported release manifest at ${manifestPath}`);
  }
  return manifest;
}

/**
 * Parse a PyPI wheel/sdist filename into the PEP 503 normalized project name,
 * version, and artifact kind.
 *
 *   kiwi_catalog-0.1.0-py3-none-any.whl  -> { name: "kiwi-catalog", version: "0.1.0", kind: "wheel" }
 *   shopping_cli-3.0.1.tar.gz            -> { name: "shopping-cli", version: "3.0.1", kind: "sdist" }
 */
const PEP440_VERSION = /^[0-9][A-Za-z0-9.+-]*$/;

export function parsePyPiFilename(filename) {
  if (filename.endsWith(".whl")) {
    const base = filename.slice(0, -".whl".length);
    const parts = base.split("-");
    // Wheel filename layout: {distribution}-{version}(-{build})?-{python}-{abi}-{platform}.whl
    if (parts.length < 5) throw new Error(`unrecognized wheel filename: ${filename}`);
    const name = parts.slice(0, parts.length - 4).join("-").replace(/_/g, "-");
    const version = parts[parts.length - 4];
    if (!PEP440_VERSION.test(version)) throw new Error(`unrecognized wheel version in ${filename}`);
    return { name, version, kind: "wheel" };
  }
  if (filename.endsWith(".tar.gz")) {
    const base = filename.slice(0, -".tar.gz".length);
    const idx = base.lastIndexOf("-");
    if (idx <= 0) throw new Error(`unrecognized sdist filename: ${filename}`);
    const name = base.slice(0, idx).replace(/_/g, "-");
    const version = base.slice(idx + 1);
    if (!PEP440_VERSION.test(version)) throw new Error(`unrecognized sdist version in ${filename}`);
    return { name, version, kind: "sdist" };
  }
  throw new Error(`unrecognized PyPI artifact filename: ${filename}`);
}

/**
 * Parse an npm pack tarball filename into package identity. Scoped packages
 * pack as `scope-name-version.tgz`; unscoped pack as `name-version.tgz`.
 *
 *   harrylabsj-kiwi-0.6.1.tgz -> { name: "@harrylabsj/kiwi", version: "0.6.1" }
 *   lodash-4.17.21.tgz        -> { name: "lodash", version: "4.17.21" }
 */
export function parseNpmTarballFilename(filename) {
  if (!filename.endsWith(".tgz")) throw new Error(`unrecognized npm tarball filename: ${filename}`);
  const base = filename.slice(0, -".tgz".length);
  const idx = base.lastIndexOf("-");
  if (idx <= 0) throw new Error(`unrecognized npm tarball filename: ${filename}`);
  const version = base.slice(idx + 1);
  if (!/^[0-9][0-9A-Za-z.+~-]*$/.test(version)) {
    throw new Error(`unrecognized npm tarball version in ${filename}`);
  }
  const namePart = base.slice(0, idx);
  const name = namePart.includes("-")
    ? `@${namePart.replace("-", "/")}`
    : namePart;
  return { name, version };
}

/** Verify a downloaded npm tarball against registry integrity and the manifest. */
export function verifyNpmDownload(buffer, expected) {
  const { name, version } = expected.identity;
  const actualSha512 = `sha512-${sha512Base64(buffer)}`;
  if (expected.integrity && actualSha512 !== expected.integrity) {
    throw new Error(
      `npm ${name}@${version} integrity mismatch: got ${actualSha512}, expected ${expected.integrity}`,
    );
  }
  const actualSha256 = sha256Hex(buffer);
  if (expected.sha256 && actualSha256 !== expected.sha256) {
    throw new Error(
      `npm ${name}@${version} sha256 mismatch vs release manifest: got ${actualSha256}, expected ${expected.sha256}`,
    );
  }
}

/** Verify a downloaded PyPI file against PyPI JSON digest and the manifest. */
export function verifyPyPiFile(buffer, expected) {
  const { name, version, filename } = expected.identity;
  const actualSha256 = sha256Hex(buffer);
  if (expected.pypiSha256 && actualSha256 !== expected.pypiSha256) {
    throw new Error(
      `PyPI ${name}@${version} ${filename} sha256 mismatch vs PyPI JSON: got ${actualSha256}, expected ${expected.pypiSha256}`,
    );
  }
  if (expected.manifestSha256 && actualSha256 !== expected.manifestSha256) {
    throw new Error(
      `PyPI ${name}@${version} ${filename} sha256 mismatch vs release manifest: got ${actualSha256}, expected ${expected.manifestSha256}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Network / registry helpers (bounded retries, fail-closed)
// ---------------------------------------------------------------------------

const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30000;

async function fetchWithRetry(url, { retries = DEFAULT_RETRIES } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(1000 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(`fetch failed for ${url}`);
}

/** Download a URL into a Buffer with bounded retries. */
export async function downloadBuffer(url, { retries = DEFAULT_RETRIES } = {}) {
  const response = await fetchWithRetry(url, { retries });
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Query the npm registry for a package version's dist metadata using `npm view`.
 * Returns { tarball, integrity, version }. The metadata is cross-checked against
 * the release manifest by the caller; it is never trusted alone.
 */
export function npmRegistryMetadata(name, version) {
  const stdout = execFileSync(
    "npm",
    ["view", `${name}@${version}`, "dist.tarball", "dist.integrity", "version", "--json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout);
  const tarball = data["dist.tarball"] ?? data.dist?.tarball;
  const integrity = data["dist.integrity"] ?? data.dist?.integrity;
  const resolvedVersion = data.version;
  if (!tarball || !integrity || !resolvedVersion) {
    throw new Error(`npm view returned incomplete metadata for ${name}@${version}`);
  }
  return { tarball, integrity, version: resolvedVersion };
}

/** Fetch a PyPI project release JSON (bounded retries). */
export async function pypiMetadata(name, version) {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  const response = await fetchWithRetry(url);
  const data = await response.json();
  if (!data.info || !Array.isArray(data.urls)) {
    throw new Error(`unexpected PyPI JSON for ${name}@${version}`);
  }
  return data;
}

/** Read the package/package.json inside an npm tarball. */
export function npmTarballPackageJson(tarballPath) {
  const stdout = execFileSync(
    "tar",
    ["-xOf", tarballPath, "package/package.json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const pkg = JSON.parse(stdout);
  if (!pkg.name || !pkg.version) {
    throw new Error(`invalid package.json in ${basename(tarballPath)}`);
  }
  return { name: pkg.name, version: pkg.version };
}
