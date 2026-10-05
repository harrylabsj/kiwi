#!/usr/bin/env node
/** A243 approved main45 isolated cloud stage: normal npm12 standalone lock, whole packages, no SDK pruning. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { inventory, sha256 } from "./a236-stage-archive.mjs";
import { assemblePacked } from "./a236-packed-merchant-assembly.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "45fbf55622b3bc3d3012d2b8a8a559f389153bfb";
const NPM = "/Users/jianghaidong/.cache/node/corepack/v1/npm/12.0.2/bin/npm-cli.js";
const REVIEWED = "/Users/jianghaidong/Documents/Codex/2026-09-29/new-chat-2/work/kiwi-a236-frozen-packed-candidate/runtime";
const EXCLUDED = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-codemode", "@earendil-works/pi-mcp"];
function json(file) { return JSON.parse(readFileSync(file)); }
function npm(args, cwd) { return execFileSync(process.execPath, [...process.execArgv, NPM, ...args], { cwd, env: { ...process.env }, encoding: "utf8", maxBuffer: 32 * 1048576 }); }
export function auditEntrypoints(stage) {
  const entries = ["app/cloud/main.js", "app/merchant/ai-runtime/owner-session.js", "app/merchant/ai-runtime/owner-trusted-factory.js", "app/merchant/ai-runtime/owner-sdk-tools.js"];
  const queue = entries.map((name) => path.join(stage, name)); const visited = new Set(); const packages = new Set(); const bare = new Set(); const missing = [];
  while (queue.length) {
    const file = queue.pop(); if (visited.has(file)) continue; visited.add(file);
    if (!existsSync(file)) { missing.push(path.relative(stage, file)); continue; }
    const text = readFileSync(file, "utf8");
    const regex = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;
    let match;
    while ((match = regex.exec(text))) {
      const spec = match[2]; if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) { const dest = path.resolve(path.dirname(file), spec); if (existsSync(dest)) queue.push(dest); else missing.push(path.relative(stage, dest)); }
      else {
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]; packages.add(name);
        bare.add(spec);
      }
    }
  }
  const code = 'import { existsSync } from "node:fs"; const specs=JSON.parse(process.argv[1]); const missing=[]; for (const spec of specs) { try { const resolved=import.meta.resolve(spec); if(resolved.startsWith("file:")&&!existsSync(new URL(resolved))) missing.push(spec); } catch { missing.push(spec); } } process.stdout.write(JSON.stringify(missing));';
  missing.push(...JSON.parse(execFileSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", code, JSON.stringify([...bare])], { cwd: stage, env: { ...process.env }, encoding: "utf8" })));
  if (missing.length || [...packages].some((name) => EXCLUDED.includes(name))) throw new Error(`A243_ENTRY_CLOSURE_MISSING ${JSON.stringify(missing)}`);
  return { entries, visited_application_files: visited.size, reachable_bare_packages: [...packages].sort(), missing };
}
export function prepareStage({ material }) {
  if (existsSync(material)) throw new Error("A243_MATERIAL_EXISTS");
  if (execFileSync("git", ["diff", BASE, "--", "src", "contracts", "package.json", "package-lock.json"], { cwd: ROOT, encoding: "utf8" }).trim()) throw new Error("A243_MAIN_SOURCE_CHANGED");
  const root = json(path.join(ROOT, "package.json")); const mainLock = json(path.join(ROOT, "package-lock.json"));
  if (root.version !== "0.12.0" || npm(["--version"], ROOT).trim() !== "12.0.2") throw new Error("A243_SOURCE_TOOLCHAIN_INVALID");
  process.stdout.write(npm(["run", "build"], ROOT));
  mkdirSync(material, { recursive: true }); const stage = path.join(material, "stage"); mkdirSync(stage);
  cpSync(path.join(ROOT, "dist"), path.join(stage, "app"), { recursive: true });
  cpSync(path.join(ROOT, "contracts"), path.join(stage, "contracts"), { recursive: true });
  mkdirSync(path.join(stage, "scripts")); cpSync(path.join(ROOT, "scripts/check-install-toolchain.mjs"), path.join(stage, "scripts/check-install-toolchain.mjs"));
  const dependencies = Object.fromEntries(Object.keys(root.dependencies).filter((name) => !EXCLUDED.includes(name)).map((name) => {
    const record = mainLock.packages[`node_modules/${name}`]; if (!record?.version) throw new Error("A243_MAIN_DIRECT_LOCK_MISSING"); return [name, record.version];
  }));
  const pkg = { name: "@harrylabsj/kiwi-main-cloud-internal-candidate", version: root.version, private: true, type: "module", main: "app/cloud/main.js", scripts: { preinstall: "node scripts/check-install-toolchain.mjs", start: "node app/cloud/main.js" }, engines: root.engines, packageManager: root.packageManager, devEngines: root.devEngines, allowScripts: root.allowScripts, overrides: root.overrides, dependencies };
  const input = path.join(ROOT, "build-inputs/a243-stage");
  if (JSON.stringify(json(path.join(input, "package.json"))) !== JSON.stringify(pkg)) throw new Error("A243_FROZEN_STAGE_PACKAGE_DRIFT");
  cpSync(path.join(input, "package.json"), path.join(stage, "package.json"));
  cpSync(path.join(input, "package-lock.json"), path.join(stage, "package-lock.json"));
  const lockHash = sha256(readFileSync(path.join(stage, "package-lock.json")));
  process.stdout.write(npm(["ci", "--omit=dev", "--os=linux", "--cpu=x64", "--libc=glibc", "--no-audit", "--no-fund"], stage));
  if (sha256(readFileSync(path.join(stage, "package-lock.json"))) !== lockHash) throw new Error("A243_STAGE_LOCK_DRIFT");
  const lock = json(path.join(stage, "package-lock.json"));
  const present = inventory(path.join(stage, "node_modules"));
  if (present.some((row) => EXCLUDED.some((name) => row.path === `${name}/package.json` || row.path.endsWith(`/node_modules/${name}/package.json`)))) throw new Error("A243_BUYER_PACKAGE_LEAK");
  for (const name of ["pi-ai", "pi-agent-core", "pi-durable"]) {
    const full = `@earendil-works/${name}`; const row = lock.packages[`node_modules/${full}`];
    if (json(path.join(stage, "node_modules", full, "package.json")).version !== "1.0.2" || row.integrity !== mainLock.packages[`node_modules/${full}`].integrity) throw new Error("A243_PI_EXACT_OR_SRI_MISMATCH");
  }
  const closure = auditEntrypoints(stage);
  const sbom = npm(["sbom", "--sbom-format", "cyclonedx", "--omit=dev"], stage); writeFileSync(path.join(stage, "closure-sbom.cdx.json"), sbom);
  cpSync(REVIEWED, path.join(material, "runtime"), { recursive: true });
  const runtime = json(path.join(material, "runtime/runtime-manifest.linux-x64.json"));
  for (const [file, hash] of [[runtime.payload_file, runtime.bin_node_gzip_sha256], [runtime.npm_payload.payload_file, runtime.npm_payload.sha256]]) {
    if (sha256(readFileSync(path.join(material, "runtime/payloads", path.basename(file)))) !== hash) throw new Error("A243_OFFICIAL_RUNTIME_CHANGED");
  }
  mkdirSync(path.join(material, "launcher")); cpSync(path.join(ROOT, "scripts/a236-reviewed-runtime-bridge.mjs"), path.join(material, "launcher/a236-reviewed-runtime-bridge.mjs"));
  const files = inventory(material).filter((row) => row.kind !== "directory");
  const stageFiles = files.filter((row) => row.path.startsWith("stage/"));
  const source = { source_format: "kiwi-main-cloud-source-v1", source_commit: BASE, assembly_source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), internal_package_version: "0.12.0", pi_sdk_version: "1.0.2", declared_target: { os: "linux", cpu: "x64", libc: "glibc", note: "npm cross-target optional dependencies only; no Linux ELF executed on Mac" }, owner_runtime_default: "dual-off/private", source_lock_sha256: sha256(readFileSync(path.join(ROOT, "package-lock.json"))), stage_lock_sha256: lockHash, closure, sdk_original_package_policy: "All stage packages retained without vendor/SDK file pruning; Buyer package excluded from independent package declarations.", reviewed_runtime: { platform: "linux", arch: "x64", node_version: runtime.node_version }, candidate_files: files.map(({ path, size, sha256, symlink_target }) => ({ path, size, sha256, ...(symlink_target === undefined ? {} : { symlink_target }) })), budget: { total_files: files.length, total_bytes: files.reduce((sum, row) => sum + row.size, 0), stage_files: stageFiles.length, stage_bytes: stageFiles.reduce((sum, row) => sum + row.size, 0) }, artifact_sha256: sha256(Buffer.from(files.map((row) => `${row.path}\0${row.size}\0${row.sha256}`).join("\n"))), platform_unverified: ["Official Linux runtime execution", "Platform architecture/upload limit", "Platform cold start/memory/disk", "Recovery/rollback", "Real model/source/owner operating authorization"] };
  const file = path.join(material, "a243-source-manifest.json"); writeFileSync(file, `${JSON.stringify(source, null, 2)}\n`);
  return { source, sourceManifestSha256: sha256(readFileSync(file)) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}; const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--material") options.material = path.resolve(args[++i]);
    else if (args[i] === "--out") options.out = path.resolve(args[++i]);
    else throw new Error("A243_ARGUMENT_INVALID");
  }
  if (!options.material || !options.out || existsSync(options.out)) throw new Error("A243_NEW_PATHS_REQUIRED");
  const prepared = prepareStage(options);
  const packed = assemblePacked({ sourceCandidate: options.material, sourceManifestSha256: prepared.sourceManifestSha256, out: options.out, sourceKind: "main45-pi102" });
  process.stdout.write(`${JSON.stringify({ source_commit: prepared.source.source_commit, assembly_commit: prepared.source.assembly_source_commit, internal_version: "0.12.0", pi_version: "1.0.2", raw_bytes: packed.budget.raw_total_bytes, expanded: packed.expanded, closure: prepared.source.closure })}\n`);
}
