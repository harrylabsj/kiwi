#!/usr/bin/env node

// Run only after @harrylabsj/kiwi-merchant-cloud has been published.
// Verify the exact registry artifact before updating the deploy skill's pin.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const refPath = path.join(root, "integrations/hosts/workbuddy/kiwi-merchant-buddy/skills/kiwi-cloud-deploy/references/release.json");
const ref = JSON.parse(readFileSync(refPath, "utf8"));
const pkg = "@harrylabsj/kiwi-merchant-cloud";
const version = JSON.parse(readFileSync(path.join(root, "packages/merchant-cloud/package.json"), "utf8")).version;
const temp = mkdtempSync(path.join(tmpdir(), "kiwi-cloud-release-"));

try {
  const registryIntegrity = execFileSync("npm", ["view", `${pkg}@${version}`, "dist.integrity", "--json"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }).trim().replace(/^"|"$/g, "");
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(registryIntegrity)) {
    throw new Error(`npm registry returned invalid dist.integrity for ${pkg}@${version}`);
  }

  const packed = JSON.parse(execFileSync("npm", ["pack", `${pkg}@${version}`, "--json", `--pack-destination=${temp}`], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }));
  if (!Array.isArray(packed) || packed.length !== 1 || packed[0].name !== pkg || packed[0].version !== version) {
    throw new Error(`npm pack did not resolve the expected published package ${pkg}@${version}`);
  }
  if (packed[0].integrity !== registryIntegrity) {
    throw new Error(`npm pack integrity ${packed[0].integrity} does not match registry dist.integrity ${registryIntegrity}`);
  }
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", path.join(temp, packed[0].filename), "package/build-manifest.json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }));
  if (manifest.runtime_version !== version || !/^sha256:[a-f0-9]{64}$/.test(manifest.artifact_sha256)) {
    throw new Error("published build-manifest.json has an unexpected runtime_version or artifact_sha256");
  }
  ref.package_version = version;
  ref.aggregate_digest = manifest.artifact_sha256;
  ref.npm_integrity = registryIntegrity;
  ref.$note = `回填自 npm registry 的正式发布物：${pkg}@${version}；运行本脚本时已逐项核对 registry dist.integrity 与下载 tarball integrity，并读取包内 build-manifest.json 的 artifact_sha256。`;
  writeFileSync(refPath, `${JSON.stringify(ref, null, 2)}\n`);
  console.log(`release.json updated from verified npm artifact ${pkg}@${version}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
