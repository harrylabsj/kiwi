#!/usr/bin/env node
/** Cold normal npm12 production installs of the two exact local tarballs. No registry publication/provider/model operation. */
import { assertInstalledLockedVersions } from "./lib/npm-bundled-edges.mjs";
import { assertAuditReport, classifyAudit } from "./lib/shipping-audit.mjs";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSource,
  assertRootReceipt,
  json,
  MAX_HOST,
  MAX_MS,
  inventory,
  npm,
  sha256,
} from "./lib/npm-shipping.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = assertSource(root),
  receipt = assertRootReceipt(root, source);
const out = path.join(root, "build/npm-shipping-cold-install");
if (existsSync(out)) throw new Error("SHIPPING_NEW_COLD_INSTALL_REQUIRED");
const remaining = () => {
  const ms = MAX_MS - (Date.now() - receipt.started_at_ms);
  if (ms <= 0) throw new Error("SHIPPING_BUILD_TIMEOUT");
  return ms;
};
const hostRoot = process.env.KIWI_SHIPPING_HOST_ROOT ?? root;
const budget = () => {
  if (inventory(hostRoot).reduce((n, r) => n + r.size, 0) > MAX_HOST)
    throw new Error("SHIPPING_HOST_BUDGET");
};
budget();
mkdirSync(out, { recursive: true });
const results = [];
for (const [name, relative, subdir, app] of [
  ["@harrylabsj/kiwi", "release/npm", "root", "dist"],
  ["@harrylabsj/kiwi-merchant-cloud", "release/npm/kiwi-merchant-cloud", "cloud", "app"],
]) {
  const candidates = readdirSync(path.join(root, relative)).filter((n) => n.endsWith(".tgz"));
  if (candidates.length !== 1) throw new Error("SHIPPING_EXACT_COLD_TARBALL_REQUIRED");
  const tgz = path.join(root, relative, candidates[0]),
    consumer = path.join(out, subdir);
  mkdirSync(consumer);
  let installed;
  let installLog;
  if (subdir === "cloud") {
    // 轻量云包：解包后先校验唯一 deployment-lock.json，再恢复部署用 package-lock.json，
    // 按它做确定性 npm ci；安装环境负责提供兼容的 Node/npm 并从 registry 下载第三方依赖。
    execFileSync("tar", ["-xzf", tgz, "-C", consumer, "--strip-components=1"], { encoding: "utf8" });
    installed = consumer;
    if (existsSync(path.join(consumer, "node_modules")))
      throw new Error("SHIPPING_CLOUD_PACKAGE_MUST_NOT_BUNDLE_NODE_MODULES");
    const deploymentLock = path.join(consumer, "deployment-lock.json");
    const packageLock = path.join(consumer, "package-lock.json");
    if (!existsSync(deploymentLock))
      throw new Error("SHIPPING_CLOUD_DEPLOYMENT_LOCK_REQUIRED");
    if (existsSync(packageLock))
      throw new Error("SHIPPING_CLOUD_CONFLICTING_LOCKS");
    const lock = json(deploymentLock);
    if (
      lock === null ||
      typeof lock !== "object" ||
      Array.isArray(lock) ||
      !Number.isInteger(lock.lockfileVersion) ||
      lock.lockfileVersion < 3 ||
      lock.packages === null ||
      typeof lock.packages !== "object" ||
      Array.isArray(lock.packages) ||
      lock.packages[""] === null ||
      typeof lock.packages[""] !== "object"
    )
      throw new Error("SHIPPING_CLOUD_DEPLOYMENT_LOCK_INVALID");
    cpSync(deploymentLock, packageLock);
    writeFileSync(path.join(consumer, ".npmrc"), "engine-strict=true\n");
    installLog = execFileSync(
      process.execPath,
      [path.join(consumer, "scripts/check-install-toolchain.mjs")],
      { cwd: consumer, encoding: "utf8", timeout: remaining() },
    );
    installLog += npm(consumer, ["ci", "--omit=dev", "--ignore-scripts"], remaining());
  } else {
    writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify(
        {
          name: `kiwi-shipping-cold-${subdir}`,
          version: "1.0.0",
          private: true,
          type: "module",
          overrides: json(path.join(root, "package.json")).overrides,
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(path.join(consumer, ".npmrc"), "engine-strict=true\n");
    installLog = npm(consumer, ["install", tgz, "--omit=dev"], remaining());
    installed = path.join(consumer, "node_modules", name);
  }
  writeFileSync(path.join(consumer, "install.log"), installLog);
  if (json(path.join(installed, "package.json")).version !== "0.12.30")
    throw new Error("SHIPPING_COLD_VERSION_MISMATCH");
  let cloudClosure;
  if (subdir === "cloud") {
    if (Object.hasOwn(json(path.join(consumer, "package.json")), "overrides"))
      throw new Error("SHIPPING_CLOUD_CALLER_OVERRIDE_FORBIDDEN");
    cloudClosure = { versions: assertInstalledLockedVersions(root, installed) };
  }
  const probe = execFileSync(
    process.execPath,
    [
      ...process.execArgv,
      path.join(root, "scripts/verify-npm-shipping-runtime.mjs"),
      installed,
      app,
    ],
    {
      cwd: consumer,
      env: { ...process.env, KIWI_OWNER_SESSION_ENABLED: "0", KIWI_AI_RUNTIME_ENABLED: "0" },
      encoding: "utf8",
      timeout: remaining(),
      maxBuffer: 32 * 1048576,
    },
  );
  writeFileSync(path.join(consumer, "runtime.log"), probe);
  if (subdir === "root") {
    const help = execFileSync(
      process.execPath,
      [...process.execArgv, path.join(installed, "dist/cli.js"), "--help"],
      {
        cwd: consumer,
        env: { ...process.env, KIWI_OWNER_SESSION_ENABLED: "0", KIWI_AI_RUNTIME_ENABLED: "0" },
        encoding: "utf8",
        timeout: remaining(),
      },
    );
    if (!help.includes("kiwi")) throw new Error("SHIPPING_CLI_HELP_MISSING");
    writeFileSync(path.join(consumer, "cli-help.log"), help);
  }
  // 与构建门禁同一套判定：`npm audit` 有公告时退出码为 1，先拿完整 JSON 再过
  // **已复核豁免清单**，只对未获豁免的公告失败。
  let audit;
  try {
    audit = npm(consumer, ["audit", "--omit=dev", "--json"], remaining());
  } catch (error) {
    if (typeof error?.stdout !== "string" || error.stdout.trim() === "") throw error;
    audit = error.stdout;
  }
  writeFileSync(path.join(consumer, "audit.json"), audit);
  const auditDecision = classifyAudit(
    assertAuditReport(JSON.parse(audit)),
    json(path.join(root, "build-inputs/shipping-audit-allow.json")),
    new Date(),
  );
  writeFileSync(
    path.join(consumer, "audit-disposition.json"),
    JSON.stringify(auditDecision, null, 2) + "\n",
  );
  if (auditDecision.blocked.length > 0) {
    const blocked = new Error("SHIPPING_AUDIT_BLOCKED");
    blocked.blocked = auditDecision.blocked;
    throw blocked;
  }
  budget();
  results.push({
    name,
    version: "0.12.30",
    source_commit: source.source_commit,
    tgz_sha256: sha256(readFileSync(tgz)),
    runtime_log_sha256: sha256(Buffer.from(probe)),
    normal_npm12_install: true,
    conservative_consumer_override_applied: subdir === "root",
    ...(cloudClosure ? { cloudClosure } : {}),
  });
}
writeFileSync(
  path.join(out, "receipt.json"),
  JSON.stringify({ source, results, no_production_or_provider_calls: true }, null, 2) + "\n",
);
console.log(
  JSON.stringify({ cold_install_receipt: "build/npm-shipping-cold-install/receipt.json", results }),
);
