#!/usr/bin/env node
/** A236 complete lossless stage archive. Local-only; no SDK pruning or platform calls. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { assertSourceStage, createStageArchive, inventory, sha256, verifyPackedCandidate } from "./a236-stage-archive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function assemblePacked({ sourceCandidate, sourceManifestSha256, out }) {
  if (!/^[a-f0-9]{64}$/.test(sourceManifestSha256 ?? "")) throw new Error("A236_EXPECTED_SOURCE_MANIFEST_HASH_REQUIRED");
  if (existsSync(out)) throw new Error("A236_OUTPUT_EXISTS");
  const sourcePath = path.join(sourceCandidate, "a192-candidate-manifest.json");
  const sourceBytes = readFileSync(sourcePath);
  if (sha256(sourceBytes) !== sourceManifestSha256) throw new Error("A236_INPUT_SOURCE_MANIFEST_HASH_MISMATCH");
  const source = JSON.parse(sourceBytes);
  if (source.source_commit !== "c8f8b18ede8833f1b96b3301718edbc8ee0a0fe2") throw new Error("A236_INPUT_SOURCE_COMMIT_UNEXPECTED");
  const physical = inventory(sourceCandidate).filter((row) => row.kind !== "directory" && row.path !== "a192-candidate-manifest.json");
  const normalize = (rows) => rows.map((row) => ({ path: row.path, size: row.size, sha256: row.sha256, ...(row.symlink_target === undefined ? {} : { symlink_target: row.symlink_target }) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(normalize(physical)) !== JSON.stringify(normalize(source.candidate_files))) throw new Error("A236_INPUT_SOURCE_FILES_CHANGED");
  const stageFiles = source.candidate_files.filter((row) => row.path.startsWith("stage/")).map((row) => ({ ...row, path: row.path.slice(6) }));
  const packed = createStageArchive(path.join(sourceCandidate, "stage"));
  assertSourceStage(packed.entries, stageFiles);
  mkdirSync(out, { recursive: true });
  mkdirSync(path.join(out, "payloads")); mkdirSync(path.join(out, "source"));
  writeFileSync(path.join(out, "payloads/merchant-stage.a236.gz"), packed.archive, { flag: "wx" });
  writeFileSync(path.join(out, "source/a232-candidate-manifest.json"), sourceBytes, { flag: "wx" });
  cpSync(path.join(sourceCandidate, "runtime"), path.join(out, "runtime"), { recursive: true });
  cpSync(path.join(sourceCandidate, "launcher"), path.join(out, "launcher"), { recursive: true });
  for (const file of ["a236-stage-archive.mjs", "a236-packed-merchant-launcher.mjs", "a236-reviewed-runtime-bridge.mjs"]) cpSync(path.join(ROOT, "scripts", file), path.join(out, "launcher", file));
  const runtimeManifest = JSON.parse(readFileSync(path.join(sourceCandidate, "runtime", `runtime-manifest.${source.reviewed_runtime.platform}-${source.reviewed_runtime.arch}.json`)));
  const files = inventory(out).filter((row) => row.kind !== "directory");
  const manifest = {
    package_format: "kiwi-packed-merchant-v1", source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    assembly_script_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))), stage_source_commit: source.source_commit,
    source_manifest: { file: "source/a232-candidate-manifest.json", sha256: sourceManifestSha256 },
    stage_archive: { file: "payloads/merchant-stage.a236.gz", sha256: packed.sha256, bytes: packed.bytes, plain_bytes: packed.plain_bytes },
    entry: "app/cloud/main.js", ai_runtime_default: "off",
    distribution_files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    expanded: { stage_files: stageFiles.length, stage_bytes: stageFiles.reduce((sum, row) => sum + row.size, 0), original_candidate_bytes: source.budget.total_bytes, original_candidate_files: source.budget.total_files,
      archive_plain_bytes: packed.plain_bytes, reviewed_node_binary_bytes_declared: runtimeManifest.bin_node_bytes, one_install_disk_bytes_declared: 0, disk_semantics: "Expanded stage and runtime installation/cache disk bytes are separate from actual distributed raw bytes; platform disk allowance unverified." },
    integrity_semantics: "Archive SHA and full original 9798-file closure establish byte integrity only, not remote source authentication, authorization or MAC.",
    install_policy: "Frozen A232 source: normal npm12 ci/preinstall validated separately; original stage builder uses --ignore-scripts. No new install, approval or dependency byte pruning here.",
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
