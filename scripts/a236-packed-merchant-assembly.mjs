#!/usr/bin/env node
/** A236 complete lossless stage archive. Local-only; no SDK pruning or platform calls. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { assertSourceStage, createStageArchive, decodeStageArchive, inventory, sha256, verifyPackedCandidate } from "./a236-stage-archive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function assemblePacked({ sourceCandidate, sourceManifestSha256, out, sourceKind = "a232-frozen", codec = "gzip-v1", quality = 9, preparedArchive, compactSource = false }) {
  if (!/^[a-f0-9]{64}$/.test(sourceManifestSha256 ?? "")) throw new Error("A236_EXPECTED_SOURCE_MANIFEST_HASH_REQUIRED");
  if (existsSync(out)) throw new Error("A236_OUTPUT_EXISTS");
  if (!["a232-frozen", "main45-pi102"].includes(sourceKind)) throw new Error("A243_SOURCE_KIND_INVALID");
  const modern = sourceKind === "main45-pi102";
  if (!["gzip-v1", "brotli-v1"].includes(codec) || (!modern && (codec !== "gzip-v1" || compactSource))) throw new Error("A244_CODEC_SCOPE_INVALID");
  const sourceFile = modern ? "a243-source-manifest.json" : "a192-candidate-manifest.json";
  const expectedSource = modern ? "45fbf55622b3bc3d3012d2b8a8a559f389153bfb" : "c8f8b18ede8833f1b96b3301718edbc8ee0a0fe2";
  const sourcePath = path.join(sourceCandidate, sourceFile);
  const sourceBytes = readFileSync(sourcePath);
  if (sha256(sourceBytes) !== sourceManifestSha256) throw new Error("A236_INPUT_SOURCE_MANIFEST_HASH_MISMATCH");
  const source = JSON.parse(sourceBytes);
  if (source.source_commit !== expectedSource) throw new Error("A236_INPUT_SOURCE_COMMIT_UNEXPECTED");
  const physical = inventory(sourceCandidate).filter((row) => row.kind !== "directory" && row.path !== sourceFile);
  const normalize = (rows) => rows.map((row) => ({ path: row.path, size: row.size, sha256: row.sha256, ...(row.symlink_target === undefined ? {} : { symlink_target: row.symlink_target }) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(normalize(physical)) !== JSON.stringify(normalize(source.candidate_files))) throw new Error("A236_INPUT_SOURCE_FILES_CHANGED");
  const stageFiles = source.candidate_files.filter((row) => row.path.startsWith("stage/")).map((row) => ({ ...row, path: row.path.slice(6) }));
  const packed = preparedArchive ?? createStageArchive(path.join(sourceCandidate, "stage"), { codec, quality });
  const checked = decodeStageArchive(packed.archive, packed);
  if (codec === "brotli-v1" && packed.codec !== codec) throw new Error("A244_PREPARED_CODEC_MISMATCH");
  assertSourceStage(checked.entries, stageFiles);
  assertSourceStage(packed.entries, stageFiles);
  mkdirSync(out, { recursive: true });
  mkdirSync(path.join(out, "payloads")); mkdirSync(path.join(out, "source"));
  const archiveFile = codec === "brotli-v1" ? "payloads/merchant-stage.a244.br" : "payloads/merchant-stage.a236.gz";
  writeFileSync(path.join(out, archiveFile), packed.archive, { flag: "wx" });
  const distributedSource = compactSource ? Buffer.from(`${JSON.stringify(source)}\n`) : sourceBytes;
  if (JSON.stringify(JSON.parse(distributedSource)) !== JSON.stringify(source)) throw new Error("A244_COMPACT_SOURCE_FIELDS_CHANGED");
  writeFileSync(path.join(out, modern ? `source/${sourceFile}` : "source/a232-candidate-manifest.json"), distributedSource, { flag: "wx" });
  cpSync(path.join(sourceCandidate, "runtime"), path.join(out, "runtime"), { recursive: true });
  cpSync(path.join(sourceCandidate, "launcher"), path.join(out, "launcher"), { recursive: true });
  for (const file of ["a236-stage-archive.mjs", "a236-packed-merchant-launcher.mjs", "a236-reviewed-runtime-bridge.mjs"]) cpSync(path.join(ROOT, "scripts", file), path.join(out, "launcher", file));
  const runtimeManifest = JSON.parse(readFileSync(path.join(sourceCandidate, "runtime", `runtime-manifest.${source.reviewed_runtime.platform}-${source.reviewed_runtime.arch}.json`)));
  const files = inventory(out).filter((row) => row.kind !== "directory");
  const manifest = {
    package_format: modern ? "kiwi-packed-main-merchant-v1" : "kiwi-packed-merchant-v1", source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    assembly_script_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))), stage_source_commit: source.source_commit,
    source_manifest: { file: modern ? `source/${sourceFile}` : "source/a232-candidate-manifest.json", sha256: sha256(distributedSource), ...(compactSource ? { original_sha256: sourceManifestSha256, serialization: "compact-json-full-deep-equal" } : {}) },
    stage_archive: { file: archiveFile, sha256: packed.sha256, bytes: packed.bytes, plain_bytes: packed.plain_bytes, ...(codec === "brotli-v1" ? { codec, quality, plain_sha256: packed.plain_sha256 } : {}) },
    entry: "app/cloud/main.js", ai_runtime_default: "off",
    ...(modern ? { internal_package_version: "0.12.0", pi_sdk_version: "1.0.2", owner_runtime_default: "dual-off/private" } : {}),
    distribution_files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    expanded: { stage_files: stageFiles.length, stage_bytes: stageFiles.reduce((sum, row) => sum + row.size, 0), original_candidate_bytes: source.budget.total_bytes, original_candidate_files: source.budget.total_files,
      archive_plain_bytes: packed.plain_bytes, reviewed_node_binary_bytes_declared: runtimeManifest.bin_node_bytes, one_install_disk_bytes_declared: 0, disk_semantics: "Expanded stage and runtime installation/cache disk bytes are separate from actual distributed raw bytes; platform disk allowance unverified." },
    integrity_semantics: "Archive SHA and full source file closure establish byte integrity only, not remote source authentication, authorization or MAC.",
    install_policy: modern ? "New independent stage package/lock: normal npm12 lock-only and ci, A106/allowScripts preserved, no SDK/package file pruning; exact direct versions from main lock." : "Frozen A232 source: normal npm12 ci/preinstall validated separately; original stage builder uses --ignore-scripts. No new install, approval or dependency byte pruning here.",
    platform_unverified: source.platform_unverified,
    budget: { max_mib: 64, raw_total_bytes: 0, raw_total_files: files.length + 1, within_budget: false, semantics: "64 MiB raw budget counts every distributed file including this outer manifest. No expanded stage directory is distributed." },
  };
  const materialBytes = files.reduce((sum, row) => sum + row.size, 0);
  let text;
  for (let i = 0; i < 20; i += 1) {
    text = `${JSON.stringify(manifest, null, 2)}\n`;
    const total = materialBytes + Buffer.byteLength(text);
    if (manifest.budget.raw_total_bytes === total && manifest.budget.within_budget === (total <= 64 * 1048576)) break;
    manifest.budget.raw_total_bytes = total;
    manifest.expanded.one_install_disk_bytes_declared = total + manifest.expanded.stage_bytes + manifest.expanded.reviewed_node_binary_bytes_declared;
    manifest.budget.within_budget = total <= 64 * 1048576;
  }
  if (materialBytes + Buffer.byteLength(text) !== manifest.budget.raw_total_bytes) throw new Error("A236_MANIFEST_BUDGET_NOT_STABLE");
  writeFileSync(path.join(out, "a236-packed-manifest.json"), text, { flag: "wx" });
  verifyPackedCandidate(out);
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--source-candidate") options.sourceCandidate = path.resolve(args[++i]);
    else if (args[i] === "--source-manifest-sha256") options.sourceManifestSha256 = args[++i];
    else if (args[i] === "--out") options.out = path.resolve(args[++i]);
    else throw new Error("A236_ARGUMENT_INVALID");
  }
  if (!options.sourceCandidate || !options.out) throw new Error("A236_ARGUMENT_REQUIRED");
  const result = assemblePacked(options);
  process.stdout.write(`${JSON.stringify({ raw_bytes: result.budget.raw_total_bytes, max_mib: 64, within_budget: result.budget.within_budget, stage_archive_bytes: result.stage_archive.bytes, expanded: result.expanded })}\n`);
}
