#!/usr/bin/env node
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_URL = "https://catalog.kiwi.harrylabsj.com";

function parseArgs(argv) {
  const options = { origin: undefined, out: undefined, dataDir: undefined, catalogUrl: DEFAULT_CATALOG_URL, allowInsecureCatalog: false, sample: false, merchantName: undefined, adminBootstrap: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--origin") options.origin = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--data-dir") options.dataDir = argv[++i];
    else if (arg === "--catalog-url") options.catalogUrl = argv[++i];
    else if (arg === "--allow-insecure-catalog") options.allowInsecureCatalog = true;
    else if (arg === "--sample") options.sample = true;
    else if (arg === "--merchant-name") options.merchantName = argv[++i];
    else if (arg === "--admin-bootstrap") options.adminBootstrap = true;
    else throw new Error(`未知参数 ${arg}`);
  }
  if (options.origin === undefined || options.out === undefined) {
    throw new Error("用法：node prepare.mjs --origin https://<host> --out <部署目录> [--catalog-url <https-url>] [--merchant-name <名称>] [--sample] [--allow-insecure-catalog] [--data-dir <绝对路径>] [--admin-bootstrap]");
  }
  return options;
}

function validateCatalogUrl(raw, options) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("--catalog-url 必须是合法 URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--catalog-url 只接受地址 origin，不得带凭据、路径、查询或片段");
  }
  if (url.protocol !== "https:") {
    if (!(options.allowInsecureCatalog && loopback && url.protocol === "http:")) {
      throw new Error("--catalog-url 必须使用 https；loopback http 需显式加 --allow-insecure-catalog");
    }
  }
  if (options.allowInsecureCatalog && !(loopback && url.protocol === "http:")) {
    throw new Error("--allow-insecure-catalog 只适用于 loopback http Catalog");
  }
  if (options.sample && !loopback) throw new Error("--sample 只允许连接 loopback Catalog，拒绝连接生产 Catalog");
  return url.origin;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function writeMerchantProfile(file, identity, merchantName) {
  writeFileSync(file, [
    "# 商家云端 profile：身份由 prepare 生成；商品由商家在工作台导入。",
    "runtime_version: 0.6.0",
    "protocol_version: shopping.negotiation/0.1",
    `agent_id: ${identity.agent_id}`,
    `name: ${yamlString(merchantName)}`,
    "role: merchant",
    `owner_id: ${identity.owner_id}`,
    "commerce:",
    "  base_url: http://127.0.0.1:1",
    "  token_env: KIWI_CLOUD_COMMERCE_TOKEN",
    "  backend: local_marketplace",
    "  allow_demo_price_fallback: false",
    "model:",
    "  provider: fake",
    "  model: fake-merchant-model",
    "runtime:",
    "  mode: once",
    "  poll_interval_seconds: 5",
    "  turn_timeout_seconds: 90",
    "  max_model_steps: 4",
    "  max_retries: 2",
    "merchant_policy:",
    "  min_unit_price_private: 0.01",
    "  max_auto_discount_percent: 0",
    "  inventory_source: marketplace",
    "  quote_ttl_seconds: 300",
    "  auto_negotiate: true",
    "",
  ].join("\n"), { mode: 0o600 });
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

function makeAdminBootstrap(identity) {
  const password = randomBytes(32).toString("base64url");
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 32, { N: 16384 }).toString("base64url");
  const credentials = { principal_id: identity.agent_id, merchant_id: identity.owner_id, password_hash: `scrypt$16384$${salt}$${hash}`, created_at: new Date().toISOString() };
  writeFileSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  return password;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const publicOrigin = validateOrigin(options.origin);
  const catalogUrl = validateCatalogUrl(options.catalogUrl, options);
  const merchantName = options.merchantName?.trim() || "待设置商家名称";
  if (merchantName.length > 80 || hasControlCharacters(merchantName)) throw new Error("--merchant-name 最长 80 个字符且不得包含控制字符");
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
  const identity = { owner_id: `merchant-${randomBytes(16).toString("hex")}` };
  identity.agent_id = `merchant-agent:${identity.owner_id}`;
  const pilotDir = path.join(out, "pilot");
  mkdirSync(pilotDir, { recursive: true });
  if (options.sample) {
    const sampleSource = path.join(PACKAGE_ROOT, "app", "cloud-sample", "products.json");
    const sampleTable = JSON.parse(readFileSync(sampleSource, "utf8"));
    sampleTable.merchant_id = identity.owner_id;
    sampleTable.runtime_owner_id = identity.owner_id;
    writeFileSync(path.join(pilotDir, "products.json"), `${JSON.stringify(sampleTable, null, 2)}\n`, { mode: 0o600 });
  } else {
    rmSync(path.join(out, "app", "cloud-sample"), { recursive: true, force: true });
  }
  writeMerchantProfile(path.join(pilotDir, "merchant.yaml"), identity, merchantName);
  const config = {
    public_origin: publicOrigin,
    data_dir: dataDir,
    profile: "pilot/merchant.yaml",
    products_file: options.sample ? "pilot/products.json" : path.join(dataDir, "products.json"),
    ...(options.sample ? { readiness_sku: "smoke-sku-1", sample: true } : {}),
    catalog_url: catalogUrl,
    merchant_name_needs_update: !options.merchantName?.trim(),
    ...(options.allowInsecureCatalog ? { allow_insecure_catalog: true } : {}),
    a2a_auth: "signature",
  };
  writeFileSync(path.join(out, "cloud.config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  let password;
  if (options.adminBootstrap) {
    password = makeAdminBootstrap(identity);
    cpSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), path.join(out, "admin-bootstrap.json"));
    rmSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), { force: true });
  }
  process.stdout.write(`${JSON.stringify({ deployment_dir: out, artifact_sha256: manifest.artifact_sha256, version: manifest.runtime_version, agent_id: identity.agent_id, catalog_url: catalogUrl, sample: options.sample, allow_insecure_catalog: options.allowInsecureCatalog })}\n`);
  if (password !== undefined) process.stdout.write(`一次性管理员口令（请立即保存）：${password}\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`[prepare] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
