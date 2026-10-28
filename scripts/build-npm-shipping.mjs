#!/usr/bin/env node
/** Approved current-source whole-package npm shipping; not the historical packed Linux runtime. */
import { assertAuditReport, classifyAudit } from "./lib/shipping-audit.mjs";
import { packRecord } from "./lib/npm-pack-record.mjs";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT,
  MAX_MS,
  MAX_HOST,
  aggregate,
  assertBudget,
  verifyTarball,
  assertNoState,
  controlledHiddenNpmLock,
  createCompiledAppProof,
  createVendorCodeProof,
  assertSource,
  assertRootReceipt,
  inventory,
  json,
  npm,
  sha256,
  sourceContract,
  git,
} from "./lib/npm-shipping.mjs";
function awaitConfig(root) {
  return git(root, ["show", "e703bc0d67e24a98c417274e46f37d210eff86ac:.npmrc"]) + "\n";
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONCRETE_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function assertLockedPiPackages(root, installedRoot) {
  const rootLock = json(path.join(root, "package-lock.json")).packages,
    stageLock = json(path.join(root, "build-inputs/release0124-stage/package-lock.json")).packages;
  const rows = inventory(installedRoot).filter((r) =>
    /(?:^|\/)@earendil-works\/pi-[^/]+\/package\.json$/.test(r.path),
  );
  const installedByLockPath = new Map(
    rows.map((row) => [`node_modules/${row.path.replace(/\/package\.json$/, "")}`, row]),
  );
  const stagePiPaths = Object.keys(stageLock).filter((p) =>
    /^node_modules\/(?:.*\/)?@earendil-works\/pi-[^/]+$/.test(p),
  );
  const rootPiPaths = Object.keys(rootLock).filter((p) =>
    /^node_modules\/(?:.*\/)?@earendil-works\/pi-[^/]+$/.test(p),
  );
  if (stagePiPaths.length === 0) throw new Error("SHIPPING_PI_PACKAGE_MISSING");
  if (
    rootPiPaths.length !== stagePiPaths.length ||
    rootPiPaths.some((p) => !stagePiPaths.includes(p))
  )
    throw new Error("SHIPPING_PI_LOCK_MISMATCH package-set");
  for (const lockPath of stagePiPaths) {
    const rootEntry = rootLock[lockPath],
      stageEntry = stageLock[lockPath];
    if (!rootEntry || !stageEntry)
      throw new Error(`SHIPPING_PI_LOCK_ENTRY_MISSING ${lockPath}`);
    for (const field of ["version", "integrity", "resolved"])
      if (
        typeof rootEntry[field] !== "string" ||
        rootEntry[field].length === 0 ||
        typeof stageEntry[field] !== "string" ||
        stageEntry[field].length === 0 ||
        rootEntry[field] !== stageEntry[field]
      )
        throw new Error(`SHIPPING_PI_LOCK_MISMATCH ${lockPath} ${field}`);
    const row = installedByLockPath.get(lockPath);
    if (!row) throw new Error(`SHIPPING_PI_PACKAGE_MISSING ${lockPath}`);
    const packagePath = lockPath.slice("node_modules/".length),
      installed = json(path.join(installedRoot, row.path));
    const packageName = packagePath.split("/").slice(-2).join("/");
    if (
      !CONCRETE_SEMVER.test(rootEntry.version) ||
      !CONCRETE_SEMVER.test(stageEntry.version) ||
      installed.name !== packageName ||
      !CONCRETE_SEMVER.test(installed.version) ||
      installed.version !== stageEntry.version
    )
      throw new Error(`SHIPPING_PI_VERSION_MISMATCH ${row.path}`);
  }
  for (const lockPath of installedByLockPath.keys())
    if (!stageLock[lockPath]) throw new Error(`SHIPPING_PI_LOCK_ENTRY_MISSING ${lockPath}`);
  return stagePiPaths.length;
}

export function buildShipping({
  root = ROOT,
  out = path.join(root, "build/cloud-artifact"),
  hostRoot = process.env.KIWI_SHIPPING_HOST_ROOT ?? root,
} = {}) {
  const source = assertSource(root),
    receipt = assertRootReceipt(root, source),
    started = receipt.started_at_ms;
  const remaining = () => {
    const ms = MAX_MS - (Date.now() - started);
    if (ms <= 0) throw new Error("SHIPPING_BUILD_TIMEOUT");
    return ms;
  };
  if (existsSync(out)) throw new Error("SHIPPING_NEW_OUTPUT_REQUIRED");
  if (inventory(hostRoot).reduce((n, r) => n + r.size, 0) > MAX_HOST)
    throw new Error("SHIPPING_HOST_BUDGET");
  if (!existsSync(path.join(root, "dist/cloud/main.js")))
    throw new Error("SHIPPING_VERIFIED_ROOT_BUILD_REQUIRED");
  const rootTgzDir = path.join(root, "release/npm");
  if (!existsSync(rootTgzDir)) throw new Error("SHIPPING_ROOT_PACK_REQUIRED");
  const rootPkg = json(path.join(root, "package.json"));
  const packedName = `${rootPkg.name.replace(/^@/, "").replace("/", "-")}-${rootPkg.version}.tgz`;
  const plan = packRecord(JSON.parse(npm(root, ["pack", "--dry-run", "--json"], remaining())), {
    name: rootPkg.name,
    version: rootPkg.version,
  });
  const expected = plan.files.map((r) => ({
    path: r.path,
    size: r.size,
    sha256: sha256(readFileSync(path.join(root, r.path))),
  }));
  for (const row of receipt.dist)
    if (
      !expected.some(
        (p) => p.path === `dist/${row.path}` && p.sha256 === row.sha256 && p.size === row.size,
      )
    )
      throw new Error("SHIPPING_DIST_NOT_IN_ROOT_PACK");
  const rootPack = verifyTarball(readFileSync(path.join(rootTgzDir, packedName)), expected);
  if (rootPack.integrity !== plan.integrity || rootPack.compressed_bytes !== plan.size)
    throw new Error("SHIPPING_ROOT_PACK_SRI_MISMATCH");

  assertSource(root); // compiled source cannot drift during build
  mkdirSync(out, { recursive: true });
  for (const name of ["package.json", "package-lock.json"])
    cpSync(path.join(root, "build-inputs/release0124-stage", name), path.join(out, name));
  mkdirSync(path.join(out, "scripts"));
  cpSync(
    path.join(root, "scripts/check-install-toolchain.mjs"),
    path.join(out, "scripts/check-install-toolchain.mjs"),
  );
  if (readFileSync(path.join(root, ".npmrc"), "utf8") !== awaitConfig(root))
    throw new Error("SHIPPING_INSTALL_CONFIG_CHANGED");
  cpSync(path.join(root, ".npmrc"), path.join(out, ".npmrc"));
  const lockHash = sha256(readFileSync(path.join(out, "package-lock.json")));
  process.stdout.write(npm(out, ["ci", "--omit=dev"], remaining()));
  if (sha256(readFileSync(path.join(out, "package-lock.json"))) !== lockHash)
    throw new Error("SHIPPING_STAGE_LOCK_CHANGED");
  const main = json(path.join(root, "package-lock.json"));
  for (const name of Object.keys(json(path.join(root, "package.json")).dependencies)) {
    if (
      json(path.join(out, "node_modules", name, "package.json")).version !==
      main.packages[`node_modules/${name}`].version
    )
      throw new Error(`SHIPPING_DIRECT_PACKAGE_MISMATCH ${name}`);
  }
  assertLockedPiPackages(root, path.join(out, "node_modules"));
  if (
    inventory(path.join(out, "node_modules"))
      .filter((r) => /(?:^|\/)brace-expansion\/package.json$/.test(r.path))
      .some((r) => json(path.join(out, "node_modules", r.path)).version !== "5.0.12")
  )
    throw new Error("SHIPPING_OVERRIDE_FAILED");
  // `npm audit` 在有公告时退出码为 1；这里要拿到完整 JSON 再做**已复核豁免**判定，
  // 不能让它直接把构建打红（否则一条上游 pin 公告会挡死全部产品）。
  let audit;
  try {
    audit = npm(out, ["audit", "--omit=dev", "--json"], remaining());
  } catch (error) {
    if (typeof error?.stdout !== "string" || error.stdout.trim() === "") throw error;
    audit = error.stdout;
  }
  writeFileSync(path.join(out, "shipping-audit.json"), audit);
  const auditDecision = classifyAudit(
    assertAuditReport(JSON.parse(audit)),
    json(path.join(root, "build-inputs/shipping-audit-allow.json")),
    new Date(),
  );
  writeFileSync(
    path.join(out, "shipping-audit-disposition.json"),
    JSON.stringify(auditDecision, null, 2) + "\n",
  );
  if (auditDecision.blocked.length > 0) {
    const error = new Error("SHIPPING_AUDIT_BLOCKED");
    error.blocked = auditDecision.blocked;
    throw error;
  }
  cpSync(path.join(root, "dist"), path.join(out, "app"), { recursive: true });
  cpSync(path.join(root, "contracts"), path.join(out, "contracts"), { recursive: true });
  writeFileSync(
    path.join(out, "index.js"),
    'import { runCloudMain } from "./app/cloud/main.js";\nconst code = await runCloudMain();\nif (code !== 0) process.exit(code);\n',
  );
  writeFileSync(
    path.join(out, "shipping-sbom.cdx.json"),
    npm(out, ["sbom", "--sbom-format", "cyclonedx", "--omit=dev"], remaining()),
  );
  writeFileSync(
    path.join(out, "shipping-source.json"),
    JSON.stringify(
      {
        ...source,
        runtime_version: json(path.join(root, "package.json")).version,
        root_pack: rootPack,
        root_build_receipt_sha256: sha256(
          readFileSync(path.join(root, "build/npm-shipping-build-receipt.json")),
        ),
        complete_root_production_dependencies: true,
        dependency_policy:
          "normal npm12 whole original installed packages; no buyer/vendor/SDK pruning",
        source_lock_sha256: sha256(readFileSync(path.join(root, "package-lock.json"))),
        installed_target: { platform: process.platform, arch: process.arch },
        owner_runtime_default: "dual-off/private",
        no_provider_or_production_execution: true,
      },
      null,
      2,
    ) + "\n",
  );
  assertSource(root);
  const files = inventory(out);
  const npmrc = readFileSync(path.join(root, ".npmrc"));
  const vendor = json(path.join(root, "build-inputs/release0124-stage/package-lock.json")).packages["node_modules/@anthropic-ai/sdk"];
  const digest = Buffer.from(vendor.integrity.slice("sha512-".length), "base64").toString("hex");
  const cache = npm(out, ["config", "get", "cache"], remaining()).trim();
  const officialTarball = path.join(cache, "_cacache/content-v2/sha512", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
  assertNoState(files, {
    artifactRoot: out,
    compiledApp: createCompiledAppProof(root, out),
    vendorCode: createVendorCodeProof(root, out, officialTarball),
    stageNpmrc: { size: npmrc.length, sha256: sha256(npmrc) },
    generatedLock: controlledHiddenNpmLock(out),
  });
  const total = assertBudget(files);
  if (inventory(hostRoot).reduce((n, r) => n + r.size, 0) > MAX_HOST)
    throw new Error("SHIPPING_HOST_BUDGET");
  remaining();
  const manifest = {
    schema_version: "0.1.2",
    artifact_kind: "kiwi-npm-shipping-stage",
    runtime_version: json(path.join(root, "package.json")).version,
    source_commit: source.source_commit,
    source_contract_sha256: source.contract_sha256,
    artifact_sha256: aggregate(files),
    files,
    file_count: files.length,
    total_bytes: total,
  };
  writeFileSync(path.join(out, "artifact-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      source_commit: source.source_commit,
      plain_bytes: total,
      files: files.length,
      build_ms: Date.now() - started,
    }) + "\n",
  );
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length) {
    if (process.argv.length !== 3 || process.argv[2] !== "--freeze-source")
      throw new Error("SHIPPING_ARGUMENT_INVALID");
    // Explicit pre-review source contract generation. Must subsequently be reviewed and committed by the release owner.
    writeFileSync(path.join(ROOT, CONTRACT), JSON.stringify(sourceContract(ROOT), null, 2) + "\n");
    console.log(
      "Source contract generated for review; build refuses until this exact contract and source are committed clean.",
    );
  } else buildShipping();
}
