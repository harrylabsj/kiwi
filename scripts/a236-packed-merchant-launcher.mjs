#!/usr/bin/env node
/** A236 new packed format launcher, local-only. Every archive and original payload is verified before cache writes. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { extractStageArchive, verifyPackedCandidate } from "./a236-stage-archive.mjs";

try {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--candidate") options.candidate = path.resolve(args[++i]);
    else if (args[i] === "--cache-dir") options.cacheDir = path.resolve(args[++i]);
    else if (args[i] === "--port") options.port = args[++i];
    else throw new Error("A236_ARGUMENT_INVALID");
  }
  if (!options.candidate || !options.cacheDir || !options.port || !/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) throw new Error("A236_ARGUMENT_REQUIRED");
  const verified = verifyPackedCandidate(options.candidate);
  const runtimeManifest = JSON.parse(readFileSync(path.join(options.candidate, "runtime", `runtime-manifest.${verified.source.reviewed_runtime.platform}-${verified.source.reviewed_runtime.arch}.json`)));
  if (runtimeManifest.platform !== process.platform || runtimeManifest.arch !== process.arch) throw new Error("A236_PLATFORM_MISMATCH");
  const cacheRelative = path.relative(options.candidate, options.cacheDir);
  if (!cacheRelative.startsWith(`..${path.sep}`) && cacheRelative !== ".." && !path.isAbsolute(cacheRelative)) throw new Error("A236_CACHE_INSIDE_DISTRIBUTION_REFUSED");
  if (!existsSync(options.cacheDir)) mkdirSync(options.cacheDir, { recursive: true });
  const privateRoot = mkdtempSync(path.join(options.cacheDir, "a236-verified-"));
  const stage = path.join(privateRoot, "stage");
  extractStageArchive(verified.archiveFile, stage, verified.manifest.stage_archive, verified.sourceFiles);
  // All NODE_OPTIONS/hooks/session/env values and explicit Node flags flow unchanged into both bridge and app.
  const child = spawn(process.execPath, [...process.execArgv, path.join(options.candidate, "launcher/a236-reviewed-runtime-bridge.mjs"), "--pkg-dir", path.join(options.candidate, "runtime"), "--app-dir", stage, "--cache-dir", path.join(privateRoot, "runtime"), "--port", options.port], { cwd: stage, env: { ...process.env }, stdio: "inherit" });
  const forward = (signal) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  process.on("SIGTERM", () => forward("SIGTERM")); process.on("SIGINT", () => forward("SIGINT"));
  child.once("error", () => { process.stderr.write("A236_CHILD_SPAWN_FAILED\n"); process.exitCode = 1; });
  child.once("exit", (code, signal) => { process.exitCode = code === null ? 1 : code; if (signal) process.stderr.write("A236_CHILD_SIGNAL_EXIT\n"); });
} catch (error) {
  const code = /^A236_[A-Z_]+$/.test(error.message ?? "") ? error.message : "A236_LAUNCHER_FAILED";
  process.stderr.write(`${code}\n`); process.exitCode = 1;
}
