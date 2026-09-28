#!/usr/bin/env node
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = { origin: undefined, out: undefined, dataDir: undefined, adminBootstrap: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--origin") options.origin = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--data-dir") options.dataDir = argv[++i];
    else if (arg === "--admin-bootstrap") options.adminBootstrap = true;
    else throw new Error(`未知参数 ${arg}`);
  }
  if (options.origin === undefined || options.out === undefined) {
    throw new Error("用法：node prepare.mjs --origin https://<host> --out <部署目录> [--data-dir <绝对路径>] [--admin-bootstrap]");
  }
  return options;
}

function validateOrigin(raw) {
  if (!/^https:\/\/[^/?#]+\/?$/.test(raw)) throw new Error("--origin 只接受 https://host[:port]，不得带路径、查询、片段或凭据");
  let url;
  try { url = new URL(raw); } catch { throw new Error("--origin 必须是合法的 https origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname || raw.includes("\\")) {
    throw new Error("--origin 只接受 https://host[:port]，不得带路径、查询、片段或凭据");
  }
  return url.origin;
}

function sha256(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function listPackageFiles(dir, prefix = "") {
  const paths = [];
  for (const name of readdirSync(dir)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (relative === "build-manifest.json" || relative === "admin-bootstrap.json" || relative.endsWith(".tgz") || relative === "node_modules/.bin" || relative === "node_modules/.package-lock.json") continue;
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) paths.push(...listPackageFiles(file, relative));
    else paths.push(relative);
  }
  return paths.sort();
}

function verifyManifest() {
  const manifestPath = path.join(PACKAGE_ROOT, "build-manifest.json");
  if (!existsSync(manifestPath)) throw new Error("包内缺少 build-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.files) || typeof manifest.artifact_sha256 !== "string") throw new Error("build-manifest.json 格式无效");
  const expectedPaths = manifest.files.map((item) => item.path).sort();
  const actualPaths = listPackageFiles(PACKAGE_ROOT);
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) throw new Error("包内文件集合与 build-manifest.json 不一致");
  for (const item of manifest.files) {
    const file = path.resolve(PACKAGE_ROOT, item.path);
    if (!file.startsWith(`${PACKAGE_ROOT}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) throw new Error(`制品文件缺失或路径越界：${item.path}`);
    if (statSync(file).size !== item.size || sha256(file) !== item.sha256) throw new Error(`制品摘要不一致：${item.path}`);
  }
  const digestLines = manifest.files.map((item) => `${item.path}\0${item.sha256}`).sort().join("\n");
  const aggregate = `sha256:${createHash("sha256").update(digestLines).digest("hex")}`;
  if (aggregate !== manifest.artifact_sha256) throw new Error("build-manifest.json 聚合摘要不一致");
  return manifest;
}

function makeAdminBootstrap() {
  const profilePath = path.join(PACKAGE_ROOT, "app", "cloud-sample", "merchant.yaml");
  if (!existsSync(profilePath)) throw new Error("生成管理员引导口令需要包内 cloud sample profile 提供 agent_id 与 owner_id");
  const profile = readFileSync(profilePath, "utf8");
  const principalId = /^agent_id:\s*(\S+)\s*$/m.exec(profile)?.[1];
  const merchantId = /^owner_id:\s*(\S+)\s*$/m.exec(profile)?.[1];
  if (!principalId || !merchantId) throw new Error("商家 profile 缺少 agent_id 或 owner_id");
  const password = randomBytes(32).toString("base64url");
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 32, { N: 16384 }).toString("base64url");
  const credentials = { principal_id: principalId, merchant_id: merchantId, password_hash: `scrypt$16384$${salt}$${hash}`, created_at: new Date().toISOString() };
  writeFileSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  return password;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const publicOrigin = validateOrigin(options.origin);
  const manifest = verifyManifest();
  const out = path.resolve(options.out);
  if (out === PACKAGE_ROOT || out.startsWith(`${PACKAGE_ROOT}${path.sep}`)) throw new Error("部署目录必须在包目录之外");
  const dataDirRaw = options.dataDir ?? "/workspace/.kiwi-runtime";
  if (!path.isAbsolute(dataDirRaw)) throw new Error("--data-dir 必须是部署目录外的绝对路径");
  const dataDir = path.resolve(dataDirRaw);
  if (dataDir === out || dataDir.startsWith(`${out}${path.sep}`)) throw new Error("--data-dir 必须是部署目录外的绝对路径");
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error("部署目录已存在且非空；请提供新的空目录");
  rmSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), { force: true });
  mkdirSync(out, { recursive: true });
  for (const name of ["app", "contracts", "node_modules", "index.js", "package.json", "build-manifest.json"]) {
    const source = path.join(PACKAGE_ROOT, name);
    if (existsSync(source)) cpSync(source, path.join(out, name), { recursive: true });
  }
  cpSync(path.join(PACKAGE_ROOT, "app", "cloud-sample"), path.join(out, "pilot"), { recursive: true });
  const config = { public_origin: publicOrigin, data_dir: dataDir, profile: "pilot/merchant.yaml", products_file: "pilot/products.json", readiness_sku: "smoke-sku-1", a2a_auth: "signature" };
  writeFileSync(path.join(out, "cloud.config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  let password;
  if (options.adminBootstrap) {
    password = makeAdminBootstrap();
    cpSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), path.join(out, "admin-bootstrap.json"));
    rmSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), { force: true });
  }
  process.stdout.write(`${JSON.stringify({ deployment_dir: out, artifact_sha256: manifest.artifact_sha256, version: manifest.runtime_version })}\n`);
  if (password !== undefined) process.stdout.write(`一次性管理员口令（请立即保存）：${password}\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`[prepare] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
