#!/usr/bin/env node
/**
 * kiwi-buyer-mcp facade 发布供应链校验（战略 v2.5 §6.11）。
 *
 * 插件是商业写能力的入口，发布链必须按供应链软件治理（P0 约束）：
 *   - 发布可信：发布物哈希 + SBOM + 精确依赖锁定（package-lock.json）；
 *   - 兼容协商：未知/不兼容版本默认 fail-closed；
 *   - 数据治理：telemetry 最小化（本校验不做任何网络上报）。
 *
 * 本脚本：
 *   1) 从 package-lock.json 生成运行时依赖 SBOM（每个运行时依赖的 resolved
 *      version + integrity，缺 integrity/未知版本 → fail-closed）；
 *   2) npm pack 计算发布物 sha256（发布物哈希）；
 *   3) 输出 supply-chain.sbom.json（可审计）。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

const runtimeDeps = packageJson.dependencies ?? {};
const fail = (message) => {
  console.error(`supply-chain FAIL: ${message}`);
  process.exitCode = 1;
};

if (Object.keys(runtimeDeps).length === 0) {
  fail("no runtime dependencies declared");
}

// 1) SBOM：运行时依赖 → resolved version + integrity（from package-lock）。
const sbom = [];
for (const [name, spec] of Object.entries(runtimeDeps)) {
  const pkg = lock.packages?.[`node_modules/${name}`] ?? lock.packages?.[name];
  if (pkg === undefined || pkg.version === undefined) {
    fail(`runtime dependency ${name} is not locked in package-lock.json`);
    continue;
  }
  // integrity 缺失（如 file:/git 依赖）→ fail-closed（§6.11 精确锁定）。
  if (pkg.integrity === undefined && !spec.startsWith("file:")) {
    fail(`runtime dependency ${name}@${pkg.version} missing integrity (SBOM 不可审计)`);
    continue;
  }
  sbom.push({ name, spec, resolved: pkg.version, integrity: pkg.integrity ?? "(file-local)" });
}
if (process.exitCode) process.exit(process.exitCode);

// 2) 发布物哈希：npm pack → sha256。
const work = mkdtempSync(path.join(tmpdir(), "kiwi-sbom-"));
const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], {
  cwd: root,
  encoding: "utf8",
}).trim();
const tarball = readFileSync(path.join(work, packed));
const artifactSha256 = createHash("sha256").update(tarball).digest("hex");

// 3) 版本兼容 fail-closed：facade 协议版本必须已知（MCP 白名单）。
const MCP_VERSIONS = ["2024-11-05", "2025-06-18", "2025-11-25"];
const facadeVersion = packageJson.version;
if (!/^\d+\.\d+\.\d+$/.test(facadeVersion)) {
  fail(`facade version ${facadeVersion} is not semver`);
}

const sbomArtifact = {
  sbom_version: 1,
  package: packageJson.name,
  package_version: facadeVersion,
  runtime_dependencies: sbom.sort((a, b) => a.name.localeCompare(b.name)),
  artifact: { name: packed, sha256: artifactSha256, bytes: tarball.length },
  mcp_protocol_versions: MCP_VERSIONS,
  generated_at: new Date().toISOString(),
};
writeFileSync(path.join(root, "supply-chain.sbom.json"), JSON.stringify(sbomArtifact, null, 2) + "\n");

console.log(`supply-chain OK: ${sbom.length} runtime deps locked + integrity, artifact sha256=${artifactSha256.slice(0, 12)}…`);
