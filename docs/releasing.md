# Releasing Kiwi

This document is the public entry point for how `@harrylabsj/kiwi` (and its
portfolio siblings `kiwi-catalog` and `shopping-cli`) are released. It is meant
for maintainers and for external contributors who want to understand why a
release looks the way it does.

## Current release candidate（2026-08-17）

- `@harrylabsj/kiwi`: `0.7.16`
- `kiwi-catalog`: `0.2.4`
- `shopping-cli`: `3.2.2`

These versions are release candidates until the protected workflow completes
`publish=true` and `verify-registry`; the immutable release ref is the full
40-character commit SHA passed to the workflow.

## Release topology

Kiwi ships as a three-repository portfolio:

| Package | Registry | Repo |
| --- | --- | --- |
| `@harrylabsj/kiwi` (this repo) | npm | `harrylabsj/kiwi` |
| `kiwi-catalog` | PyPI | `harrylabsj/kiwi-catalog` |
| `shopping-cli` | PyPI | `harrylabsj/shopping-cli` |

`portfolio.lock.json` in this repo pins the exact consumer commits
(`kiwi-catalog`, `shopping-cli`) and the contract source commit
(`contract_source_commit`) plus the contract bundle SHA-256. A release builds
all three packages from these locked inputs and publishes them as one bundle.

## The only publishing workflow

`.github/workflows/portfolio-release.yml` (`Portfolio protected release`) is the
**only** workflow that can publish to npm or PyPI. It is:

- **Manual only** — triggered via `workflow_dispatch`; it never runs on push or
  on a schedule.
- **Serialized** — a `portfolio-release` concurrency group with
  `cancel-in-progress: false`, so releases never overlap or auto-cancel.
- **Protected** — the `publish` job runs in the `kiwi-release` GitHub
  environment with human-approval reviewers and a pinned deployment branch.

The job chain is:

1. **`build-once`** — checks out the central source at `inputs.ref`, validates
   the portfolio lock, checks out the two consumer repos at their locked SHAs,
   verifies pinned checkouts and contract locks, runs the Kiwi full verify
   suite plus the consumers' locked deterministic tests and contract-lock
   checks, builds the release artifacts exactly once, generates SBOM evidence,
   `SHA256SUMS`, a release manifest, keyless cosign signature, and build
   provenance attestation, then uploads an immutable artifact.
2. **`publish`** (only if `publish=true`) — downloads that immutable artifact,
   re-verifies the manifest, and publishes the exact tarballs/wheels with
   short-lived OIDC credentials (npm `--provenance`, PyPI Trusted Publishing).
3. **`verify-registry`** (only if `publish=true`) — re-downloads the published
   artifacts from npm/PyPI and fails closed if any digest no longer matches the
   recorded manifest.
4. **`rollback-verify`** (only if `verify_rollback=true`) — read-only check that
   a previous release manifest's artifacts still match their recorded digests.

## Dry-run is the default

The `publish` input **defaults to `false`**. A dry-run dispatch:

- checks out and verifies all three repos at the locked SHAs,
- runs the composition gate and all verify suites,
- builds the npm tarball, Python wheels/sdist, contracts bundle, and SBOMs,
- computes `SHA256SUMS` and the release manifest,
- signs the bundle with keyless cosign and attests build provenance,
- uploads the artifact,

…and **never contacts npm or PyPI**. Treat a successful dry-run as a release
candidate rehearsal; the exact artifact it produced is the artifact a
subsequent `publish=true` run would publish.

## Trusted Publisher / OIDC prerequisites

There are **no long-lived registry credentials** in this repository. Publishing
relies on GitHub OIDC and the short-lived tokens minted for the protected
environment. Before the first real publish, a repository/org admin must
configure:

1. **GitHub Environment `kiwi-release`** (Settings → Environments):
   - at least one required reviewer (human approval gate), and
   - the deployment branch/ref pinned to the protected `main` branch.
2. **npm Trusted Publisher** for `@harrylabsj/kiwi`:
   - owner `harrylabsj`, repository `kiwi`,
   - workflow path `.github/workflows/portfolio-release.yml`,
   - environment `kiwi-release`.
3. **PyPI Trusted Publisher** for **both** `kiwi-catalog` and `shopping-cli`,
   with the same GitHub mapping (owner `harrylabsj`, repo `kiwi`, workflow
   `portfolio-release.yml`, environment `kiwi-release`).

After this is in place, `publish=true` uses npm
`--provenance --access public` and `uv publish --trusted-publishing always`
with the environment-scoped OIDC token. Never add `NPM_TOKEN`, `PYPI_TOKEN`,
`TWINE_PASSWORD`, PATs, or private keys to the workflow or repository secrets
for publishing.

## Version, tag, and release flow

1. **Bump versions before every publish.** Bump `version` in
   `package.json`/`package-lock.json` for `@harrylabsj/kiwi`, and
   `version` in `kiwi-catalog/pyproject.toml` and
   `shopping-cli/pyproject.toml` (plus their lockfiles). Update
   `portfolio.lock.json` consumer SHAs and contract locks as needed, then
   commit. **Never reuse a version number** — npm/PyPI do not allow republishing
   a version, and rollback is always a new patch.
2. **Dry-run first.** Manually dispatch `Portfolio protected release` with
   `publish=false`. A named branch is allowed for rehearsal, but a full
   40-character lowercase commit SHA gives reproducible evidence.
3. **Protected publish.** After the dry-run succeeds, dispatch again with:
   - `publish=true`, and
   - `ref` set to the **full 40-character lowercase commit SHA** of the central
     source to release. Named refs are rejected when `publish=true`; short SHAs
     are always rejected.
   The `publish` job requires the `kiwi-release` reviewer approval, then
   publishes the exact artifact built by `build-once` (it never rebuilds).
4. **Tag.** After the publish jobs pass, tag the released commit in this repo
   with the npm version, e.g. `git tag v0.6.0` and push the tag. Tags are
   lightweight release markers; the registry remains the source of truth.
5. **Verify the registry.** The `verify-registry` job re-downloads the npm and
   PyPI artifacts and compares them against the release manifest digests; any
   mismatch fails the run closed.

Note on the central ref vs. `portfolio.lock.json`: the lock's
`repositories.kiwi.commit` entry is a SHA-shaped **snapshot anchor only**. A
commit cannot contain its own hash, so that entry is validated for shape only
and is never compared against `inputs.ref`. The reproducibility boundary is the
consumer SHAs and `contract_source_commit`, which are verified against the
checked-out source.

## Rollback

Rollback is **never** a delete or unpublish — it is pointing consumers back at
a previously verified version:

1. Obtain the previous release's `release-manifest.json` (an `https://` URL or a
   workspace path).
2. Manually dispatch the workflow with `verify_rollback=true`,
   `previous_manifest=<that reference>`, and `publish=false`.
3. `rollback-verify` read-only checks that the previous manifest's npm/PyPI
   artifacts still match the registry digests. It never deletes, overwrites, or
   republishes.
4. If the candidate passes, repoint deployment configuration / consumer locks
   to that earlier version. To restore a fixed version, pick the newly verified
   digest and release it as a new patch.

Local, offline drill scripts also exist:

- `scripts/verify-release-manifest.mjs` — verify a release manifest on disk.
- `scripts/verify-rollback-candidate.mjs` — verify a previous release candidate.
- `scripts/rollback-drill.mjs` — local non-destructive rollback drill.

## Pre-release checklist

- [ ] `npm ci` and `npm run verify` pass locally (lint, typecheck, build, tests,
      contracts, vectors, package smoke).
- [ ] `kiwi-catalog` and `shopping-cli` pass their locked install, contract-lock
      verification, and deterministic test suites.
- [ ] `portfolio.lock.json` and each consumer contract lock are consistent
      (same `contract_source_commit` and `contract_bundle_sha256`).
- [ ] All three package versions are bumped to never-before-used numbers and the
      lockfiles are updated in the same commit.
- [ ] A `publish=false` dry-run completes with a clean signed, attested artifact.
- [ ] The `kiwi-release` environment, npm Trusted Publisher, and PyPI Trusted
      Publisher mappings exist (one-time admin setup; see above).
- [ ] The exact commit SHA to publish is recorded for the `ref` input.

## Security properties

- **Least privilege** — every workflow sets `permissions: contents: read` at
  the top level; only the jobs that sign/attest or publish add `id-token: write`
  and `attestations: write`. There is no `contents: write` or registry-token
  grant.
- **SHA pinning** — every `uses:` action reference across workflows is a full
  40-character commit SHA with the matching release tag in a comment; no mutable
  refs (`@v4`, `@main`) are allowed.
- **Ref validation** — publishing requires a full 40-character lowercase SHA;
  short SHAs are rejected and named refs are dry-run-only.
- **Provenance** — the release bundle is keyless-signed with cosign and attested
  with `actions/attest-build-provenance`, and npm publishes with
  `--provenance`.

## Related documentation

- Production website: <https://kiwi.harrylabsj.com/>
- Contribution guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
