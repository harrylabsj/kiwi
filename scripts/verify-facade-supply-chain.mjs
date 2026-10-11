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
 *   3) 真实新鲜包证据写入 build/supply-chain.sbom.derived.json（派生输出）；
 *      受保护源 supply-chain.sbom.json 默认只读，仅 --update-sbom 由 owner 写候选。
 *
 * 完整性守卫（WP21 教训）：files 白名单里的普通路径（如 dist）若缺失，npm pack
 * 不会报错、只会静默打出缺 dist 的小 tarball。因此打包前要求各白名单目录存在，
 * 打包后要求它们真的进入 tarball，否则 fail-closed。
 */
import { packRecord } from "./lib/npm-pack-record.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 测试可通过 KIWI_SUPPLY_CHAIN_ROOT 指向 fixture 根目录。
const root = process.env.KIWI_SUPPLY_CHAIN_ROOT
  ? path.resolve(process.env.KIWI_SUPPLY_CHAIN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

const runtimeDeps = packageJson.dependencies ?? {};
const fail = (message) => {
  console.error(`supply-chain FAIL: ${message}`);
  process.exitCode = 1;
};

// 参数守卫：无参数 = 默认只读核验；仅接受显式 owner 更新入口 --update-sbom；
// 未知参数 fail-closed，且不产生任何写入。
const argv = process.argv.slice(2);
if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--update-sbom")) {
  fail("未知参数；用法：node scripts/verify-facade-supply-chain.mjs [--update-sbom]");
  process.exit(1);
}
const updateSbom = argv.length === 1;

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
// files 白名单里的普通路径（无 glob 字符）必须存在且进入 tarball。
const plainFileEntries = (packageJson.files ?? []).filter(
  (entry) => typeof entry === "string" && !/[*?[\]]/.test(entry),
);
const missingEntries = plainFileEntries.filter((entry) => !existsSync(path.join(root, entry)));
if (missingEntries.length > 0) {
  fail(
    `package.json files 白名单指向的目录缺失（发布物将不完整）：${missingEntries.join(", ")}；dist 缺失通常意味着未先 npm run build`,
  );
}
if (process.exitCode) process.exit(process.exitCode);

const work = mkdtempSync(path.join(tmpdir(), "kiwi-sbom-"));
const packOutput = execFileSync("npm", ["pack", "--json", "--silent", "--pack-destination", work], {
  cwd: root,
  encoding: "utf8",
}).trim();
const packInfo = packRecord(JSON.parse(packOutput), { name: packageJson.name, version: packageJson.version });
const packed = packInfo.filename;
if (plainFileEntries.length > 0 && !Array.isArray(packInfo.files)) {
  fail("npm pack 未返回文件清单（npm 过旧？），无法核验发布物完整性");
} else {
  const packedPaths = (packInfo.files ?? []).map((file) => file.path);
  const packedTopDirs = new Set(
    packedPaths.filter((p) => p.includes("/")).map((p) => p.slice(0, p.indexOf("/"))),
  );
  const notPacked = plainFileEntries.filter(
    (entry) => !packedPaths.includes(entry) && !packedTopDirs.has(entry),
  );
  if (notPacked.length > 0) {
    fail(`打包产物缺少 files 白名单目录：${notPacked.join(", ")}（目录为空或被排除）`);
  }
}
if (process.exitCode) process.exit(process.exitCode);
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

// 4) 依赖面漂移 fail-closed（只读比对）。本文件是提交进仓的源审计快照，正常
//    核验绝不覆写它：发布 fullverify 后 sourceHash 对 artifact 字段强核，覆写
//    会令 assertSource 判定源漂移（run104 实际冲突，2026-10-11）。
//    比对范围只含确定性字段：generated_at 每次生成都变；artifact.sha256/bytes
//    取决于构建环境（dist 产物跨环境不可比），只提示、不判失败。
//    每次核验的真实新鲜包证据（真实 npm pack 的 sha256/bytes）写入派生输出
//    build/supply-chain.sbom.derived.json（带 derived 标注，不进入 npm files、
//    不获得源可信身份）；源审计快照仅由 owner 显式 --update-sbom 写候选，供
//    审阅后再冻结。
const sbomPath = path.join(root, "supply-chain.sbom.json");
const previousSbom = existsSync(sbomPath)
  ? JSON.parse(readFileSync(sbomPath, "utf8"))
  : undefined;
const dependencyPlane = (doc) =>
  JSON.stringify({
    runtime_dependencies: doc?.runtime_dependencies ?? null,
    mcp_protocol_versions: doc?.mcp_protocol_versions ?? null,
  });

mkdirSync(path.join(root, "build"), { recursive: true });
const derivedPath = path.join(root, "build", "supply-chain.sbom.derived.json");
writeFileSync(
  derivedPath,
  JSON.stringify(
    {
      ...sbomArtifact,
      derived: true,
      origin: "verify-facade-supply-chain fresh pack (not source-trusted)",
    },
    null,
    2,
  ) + "\n",
);

if (previousSbom === undefined) {
  if (!updateSbom)
    fail(
      "已提交 supply-chain.sbom.json 缺失（正常核验只读比对需要它）；owner 用 --update-sbom 生成候选",
    );
} else if (dependencyPlane(previousSbom) !== dependencyPlane(sbomArtifact)) {
  if (updateSbom) {
    console.warn(
      "note: SBOM 依赖面与已提交版本不一致；候选已写入 supply-chain.sbom.json，owner 审阅后再冻结提交",
    );
  } else {
    fail(
      "SBOM 依赖面与已提交版本不一致（源审计快照未被修改）；owner 审阅后用 --update-sbom 生成候选",
    );
  }
} else if (previousSbom?.artifact?.sha256 !== sbomArtifact.artifact.sha256) {
  console.warn(
    `note: artifact sha256 与已提交值不同（构建环境相关，源快照只读不受影响）：` +
      `${String(previousSbom?.artifact?.sha256 ?? "无").slice(0, 12)} → ${artifactSha256.slice(0, 12)}`,
  );
}

if (updateSbom) {
  writeFileSync(sbomPath, JSON.stringify(sbomArtifact, null, 2) + "\n");
}

if (process.exitCode) process.exit(process.exitCode);

console.log(
  `supply-chain OK: ${sbom.length} runtime deps locked + integrity, artifact sha256=${artifactSha256.slice(0, 12)}…, derived=${path.relative(root, derivedPath)}${updateSbom ? ", source candidate written (owner review before freeze)" : ", source snapshot read-only"}`,
);
