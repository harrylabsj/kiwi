/** Current npm shipping contract: complete production packages, immutable source, no historical guard relaxation. */
import { gunzipSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import {
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  writeFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
export const BASE = "e703bc0d67e24a98c417274e46f37d210eff86ac";
export const VERSION = "0.12.4";
export const CONTRACT = "build-inputs/release0124-source.json";
export const MAX_PLAIN = 256 * 1048576,
  MAX_TGZ = 100000000,
  MAX_HOST = 3 * 1024 ** 3,
  MAX_MS = 45 * 60 * 1000;
export const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const json = (file) => JSON.parse(readFileSync(file, "utf8"));
export function git(root, args) {
  const common = execFileSync("git", ["--no-replace-objects", "rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trimEnd();
  const grafts = path.resolve(root, common, "info/grafts");
  try {
    lstatSync(grafts);
    throw new Error("SHIPPING_GIT_GRAFTS_NOT_ALLOWED");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return execFileSync("git", ["--no-replace-objects", ...args], { cwd: root, encoding: "utf8" }).trimEnd();
}
export function inventory(dir, prefix = "") {
  const rows = [];
  for (const name of readdirSync(path.join(dir, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const file = path.join(dir, relative),
      s = lstatSync(file);
    if (s.isDirectory()) rows.push(...inventory(dir, relative));
    else if (s.isFile())
      rows.push({ path: relative, size: s.size, sha256: sha256(readFileSync(file)) });
    else if (s.isSymbolicLink()) {
      const target = readlinkSync(file),
        dest = path.resolve(path.dirname(file), target);
      if (!dest.startsWith(path.resolve(dir) + path.sep))
        throw new Error("SHIPPING_SYMLINK_ESCAPE");
      rows.push({
        path: relative,
        size: Buffer.byteLength(target),
        sha256: sha256(Buffer.from(target)),
        symlink_target: target,
      });
    } else throw new Error("SHIPPING_SPECIAL_FILE");
  }
  return rows;
}
export function aggregate(rows) {
  return sha256(
    Buffer.from(
      rows
        .map((r) => `${r.path}\0${r.sha256}`)
        .sort()
        .join("\n"),
    ),
  );
}
export function assertBudget(rows, max = MAX_PLAIN) {
  const bytes = rows.reduce((n, r) => n + r.size, 0);
  if (bytes > max) throw new Error(`SHIPPING_PLAIN_BUDGET ${bytes} > ${max}`);
  return bytes;
}
export function assertFiles(dir, manifest, { excluded = ["build-manifest.json"] } = {}) {
  const current = inventory(dir).filter((r) => !excluded.includes(r.path));
  if (
    JSON.stringify(current) !== JSON.stringify(manifest.files) ||
    aggregate(current) !== manifest.artifact_sha256 ||
    current.length !== manifest.file_count ||
    current.reduce((n, r) => n + r.size, 0) !== manifest.total_bytes
  )
    throw new Error("SHIPPING_FILES_CHANGED");
  return current;
}
export function assertOfficialNpmPayload(npmRoot, payload) {
  const integrity =
    "sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw==";
  if (
    payload.format !== "kiwi-official-npm-payload/1" ||
    payload.name !== "npm" ||
    payload.version !== "12.0.2" ||
    payload.integrity !== integrity ||
    payload.tarball_sha256 !==
      "sha256:5dbb86c71d07a1957f2e90734092dd6a58bdcd9ebc2d8d41ca1c6e6a21d364e1" ||
    payload.regular_file_count !== 1942 ||
    payload.files.length !== 1942
  )
    throw new Error("SHIPPING_OFFICIAL_NPM_CONTRACT_INVALID");
  const current = inventory(npmRoot).sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    locator = current.find((r) => r.path === ".corepack");
  const official = current.filter((r) => r.path !== ".corepack");
  if (JSON.stringify(official) !== JSON.stringify(payload.files))
    throw new Error("SHIPPING_OFFICIAL_NPM_PAYLOAD_CHANGED");
  if (locator) {
    const data = json(path.join(npmRoot, ".corepack"));
    const keys = (object) => Object.keys(object).sort().join(",");
    if (
      locator.symlink_target ||
      keys(data) !== "bin,hash,locator" ||
      keys(data.locator) !== "name,reference" ||
      keys(data.bin) !== "npm,npx" ||
      data.locator.name !== "npm" ||
      data.locator.reference !== "12.0.2" ||
      data.bin.npm !== "./bin/npm-cli.js" ||
      data.bin.npx !== "./bin/npx-cli.js" ||
      data.hash !== "sha512." + Buffer.from(integrity.slice(7), "base64").toString("hex")
    )
      throw new Error("SHIPPING_COREPACK_LOCATOR_INVALID");
  }
  return {
    npm_code_sha256: aggregate(official),
    official_tarball_integrity: integrity,
    canonical_file_count: official.length,
    nonpayload: locator ? [{ ...locator, classification: "matching-corepack-locator" }] : [],
  };
}
export function toolchain(root) {
  const npmVersion = execFileSync("npm", ["--version"], { cwd: root, encoding: "utf8" }).trim();
  if (npmVersion !== "12.0.2" || process.version !== "v22.22.3")
    throw new Error("SHIPPING_TOOLCHAIN_CHANGED");
  execFileSync(
    process.execPath,
    [...process.execArgv, path.join(root, "scripts/check-install-toolchain.mjs"), npmVersion],
    { cwd: root, env: { ...process.env }, stdio: "pipe" },
  );
  const launcher = realpathSync(execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
  const npmRoot = path.resolve(path.dirname(launcher), "..");
  if (
    json(path.join(npmRoot, "package.json")).version !== npmVersion ||
    path.basename(launcher) !== "npm-cli.js"
  )
    throw new Error("SHIPPING_NPM_CLI_REQUIRED");
  const canonical = assertOfficialNpmPayload(
    npmRoot,
    json(path.join(root, "build-inputs/release0124-npm12-payload.json")),
  );
  return {
    node: process.version,
    npm: npmVersion,
    npm_cli_sha256: sha256(readFileSync(launcher)),
    npm_code_sha256: canonical.npm_code_sha256,
    npm_official_payload_integrity: canonical.official_tarball_integrity,
    npm_official_payload_file_count: canonical.canonical_file_count,
    npm_nonpayload: canonical.nonpayload,
    node_binary_sha256: sha256(readFileSync(process.execPath)),
    platform: process.platform,
    arch: process.arch,
  };
}
export function stagePackage(root) {
  const pkg = json(path.join(root, "package.json"));
  return {
    name: "@harrylabsj/kiwi-npm-shipping-stage",
    version: pkg.version,
    private: true,
    type: "module",
    main: "index.js",
    scripts: { preinstall: pkg.scripts.preinstall, start: "node index.js" },
    ...Object.fromEntries(
      ["engines", "packageManager", "devEngines", "allowScripts", "overrides", "dependencies"].map(
        (k) => [k, pkg[k]],
      ),
    ),
  };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function assertStageLock(root) {
  const pkg = json(path.join(root, "build-inputs/release0124-stage/package.json")),
    lock = json(path.join(root, "build-inputs/release0124-stage/package-lock.json")),
    main = json(path.join(root, "package-lock.json"));
  if (
    !same(pkg, stagePackage(root)) ||
    lock.version !== VERSION ||
    lock.packages[""].version !== VERSION ||
    !same(lock.packages[""].dependencies, pkg.dependencies)
  )
    throw new Error("SHIPPING_STAGE_DECLARATION_CHANGED");
  for (const [name, row] of Object.entries(lock.packages))
    if (
      name &&
      (row.version !== main.packages[name]?.version ||
        row.integrity !== main.packages[name]?.integrity ||
        row.resolved !== main.packages[name]?.resolved)
    )
      throw new Error(`SHIPPING_LOCK_SRI_CHANGED ${name}`);
  for (const [name, row] of Object.entries(main.packages))
    if (name && !lock.packages[name] && !row.dev)
      throw new Error(`SHIPPING_PRODUCTION_LOCK_MISSING ${name}`);
  for (const name of Object.keys(pkg.dependencies))
    if (!lock.packages[`node_modules/${name}`]?.integrity)
      throw new Error("SHIPPING_DIRECT_SRI_MISSING");
  return {
    package_sha256: sha256(
      readFileSync(path.join(root, "build-inputs/release0124-stage/package.json")),
    ),
    lock_sha256: sha256(
      readFileSync(path.join(root, "build-inputs/release0124-stage/package-lock.json")),
    ),
  };
}
function validRfc3339(text) {
  if (typeof text !== "string") return false;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(text);
  if (!m || !Number.isFinite(Date.parse(text))) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (m[7] === "Z" || (Number(m[8]) <= 23 && Number(m[9]) <= 59))
  );
}
export function sourceHash(root, p) {
  if (p === "supply-chain.sbom.json") {
    const data = json(path.join(root, p));
    if (
      data.sbom_version !== 1 ||
      data.package !== "@harrylabsj/kiwi" ||
      data.package_version !== VERSION ||
      !Array.isArray(data.runtime_dependencies) ||
      !Array.isArray(data.mcp_protocol_versions) ||
      typeof data.artifact?.name !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.artifact?.sha256 ?? "") ||
      !Number.isSafeInteger(data.artifact?.bytes) ||
      data.artifact.bytes < 1 ||
      !validRfc3339(data.generated_at) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        data.generated_at,
      ) ||
      !Number.isFinite(Date.parse(data.generated_at))
    )
      throw new Error("SHIPPING_SBOM_SCHEMA_OR_TIME_INVALID");
    delete data.generated_at;
    return sha256(Buffer.from(JSON.stringify(data)));
  }
  return sha256(readFileSync(path.join(root, p)));
}
/** Clean, pinned foreign checkouts are inputs to Portfolio, never root npm payload. */
export function assertForeignCheckouts(root) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error("SHIPPING_FOREIGN_ROOT_INVALID");
  const names = ["shopping-cli", "kiwi-catalog", "hermes-plugin-kiwi"];
  const present = names.filter((name) => existsSync(path.join(root, name)) || (() => {
    try { lstatSync(path.join(root, name)); return true; } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  })());
  if (!present.length) return [];
  // Authority metadata must itself be the reviewed, committed root source.
  const contract = json(path.join(root, CONTRACT));
  if (contract.format !== "kiwi-npm-shipping-source/1" || contract.source_base !== BASE || contract.reviewed_release !== VERSION)
    throw new Error("SHIPPING_SOURCE_CONTRACT_CHANGED");
  if (git(root, ["show", `HEAD:${CONTRACT}`]) !== readFileSync(path.join(root, CONTRACT), "utf8").trim())
    throw new Error("SHIPPING_UNCOMMITTED_CONTRACT");
  for (const file of ["portfolio.lock.json", "portfolio-products.json"]) {
    if (!lstatSync(path.join(root, file)).isFile() || lstatSync(path.join(root, file)).isSymbolicLink())
      throw new Error("SHIPPING_FOREIGN_AUTHORITY_CHANGED");
    const bytes = readFileSync(path.join(root, file));
    if (contract.files.filter((row) => row.path === file && row.sha256 === sha256(bytes)).length !== 1 ||
        git(root, ["show", `HEAD:${file}`]) !== bytes.toString("utf8").trimEnd())
      throw new Error("SHIPPING_FOREIGN_AUTHORITY_CHANGED");
  }
  const lock = json(path.join(root, "portfolio.lock.json"));
  const products = json(path.join(root, "portfolio-products.json"));
  const hermes = products.products.filter((item) => item.id === "hermes-plugin-kiwi");
  if (hermes.length !== 1) throw new Error("SHIPPING_FOREIGN_PIN_INVALID");
  const pins = {
    "shopping-cli": { repository: "harrylabsj/shopping-cli", pin: lock.repositories["shopping-cli"], contract: "shopping_cli/contracts/kiwi-contracts.lock.json" },
    "kiwi-catalog": { repository: "harrylabsj/kiwi-catalog", pin: lock.repositories["kiwi-catalog"], contract: "kiwi_catalog/contracts/kiwi-contracts.lock.json" },
    "hermes-plugin-kiwi": { repository: "harrylabsj/hermes-plugin-kiwi", pin: { repository: hermes[0].repository, commit: hermes[0].source_commit } },
  };
  for (const name of present) {
    const dir = path.join(root, name), entry = pins[name];
    if (!entry.pin || entry.pin.repository !== entry.repository || !/^[0-9a-f]{40}$/.test(entry.pin.commit))
      throw new Error("SHIPPING_FOREIGN_PIN_INVALID");
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== path.join(realpathSync(root), name) ||
        !lstatSync(path.join(dir, ".git")).isDirectory() || lstatSync(path.join(dir, ".git")).isSymbolicLink() ||
        realpathSync(git(dir, ["rev-parse", "--show-toplevel"])) !== realpathSync(dir) ||
        realpathSync(git(dir, ["rev-parse", "--absolute-git-dir"])) !== path.join(realpathSync(dir), ".git"))
      throw new Error("SHIPPING_FOREIGN_ROOT_INVALID");
    if (git(root, ["ls-files", "-z", "--", name])) throw new Error("SHIPPING_FOREIGN_ROOT_TRACKED");
    if (git(dir, ["rev-parse", "HEAD"]) !== entry.pin.commit) throw new Error("SHIPPING_FOREIGN_HEAD_CHANGED");
    // Direct blob/mode checks also detect assume-unchanged and skip-worktree edits.
    const entries = git(dir, ["ls-tree", "-r", "-z", "HEAD"]).split("\0").filter(Boolean);
    const allowed = new Set([".git"]);
    for (const row of entries) {
      const split = row.indexOf("\t"), [mode, type, oid] = row.slice(0, split).split(" "), relative = row.slice(split + 1);
      if (split < 0 || type !== "blob" || !["100644", "100755", "120000"].includes(mode) || relative.split("/").some((part) => !part || part === "." || part === ".."))
        throw new Error("SHIPPING_FOREIGN_TREE_INVALID");
      allowed.add(relative);
      let parent = dir;
      for (const part of relative.split("/").slice(0, -1)) {
        parent = path.join(parent, part);
        allowed.add(path.relative(dir, parent));
        if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
          throw new Error("SHIPPING_FOREIGN_TRACKED_CHANGED");
      }
      const file = path.join(dir, relative), stat = lstatSync(file);
      let bytes;
      if (mode === "120000") {
        if (!stat.isSymbolicLink() || !realpathSync(file).startsWith(realpathSync(dir) + path.sep))
          throw new Error("SHIPPING_FOREIGN_TRACKED_CHANGED");
        bytes = Buffer.from(readlinkSync(file));
      } else {
        if (!stat.isFile() || stat.isSymbolicLink() || ((stat.mode & 0o111) !== 0) !== (mode === "100755") ||
            !realpathSync(file).startsWith(realpathSync(dir) + path.sep))
          throw new Error("SHIPPING_FOREIGN_TRACKED_CHANGED");
        bytes = readFileSync(file);
      }
      const digest = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
      if (digest !== oid) throw new Error("SHIPPING_FOREIGN_TRACKED_CHANGED");
    }
    // Git does not enumerate empty directories: reject those as well.
    const scan = (prefix) => {
      for (const name of readdirSync(path.join(dir, prefix))) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (!allowed.has(relative)) throw new Error("SHIPPING_FOREIGN_DIRTY");
        if (relative !== ".git" && lstatSync(path.join(dir, relative)).isDirectory()) scan(relative);
      }
    };
    scan("");
    if (git(dir, ["status", "--porcelain", "--untracked-files=all"]) ||
        git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]) ||
        git(dir, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]))
      throw new Error("SHIPPING_FOREIGN_DIRTY");
    if (entry.contract) {
      const declared = json(path.join(dir, entry.contract));
      if (declared.source_commit !== lock.contract_source_commit || declared.bundle_sha256 !== lock.contract_bundle_sha256)
        throw new Error("SHIPPING_FOREIGN_CONTRACT_CHANGED");
    } else if (json(path.join(dir, "plugin.json")).version !== hermes[0].version) {
      throw new Error("SHIPPING_FOREIGN_VERSION_CHANGED");
    }
  }
  return present;
}
function isForeignPath(file, roots) {
  return roots.some((root) => file === root || file.startsWith(root + "/"));
}
export function sourceContract(root) {
  return sourceContractWithForeign(root, assertForeignCheckouts(root));
}
function sourceContractWithForeign(root, foreign) {
  const sourcePaths = [
    ...new Set([
      ...git(root, ["ls-files", "-z"]).split("\0"),
      ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ]),
  ]
    .filter((p) => p && p !== CONTRACT && !isForeignPath(p, foreign))
    .sort();
  return {
    format: "kiwi-npm-shipping-source/1",
    source_base: BASE,
    reviewed_release: VERSION,
    owner_runtime_default: "dual-off/private",
    tool: toolchain(root),
    stage: assertStageLock(root),
    budgets: {
      plain_bytes: MAX_PLAIN,
      tgz_bytes_exclusive: MAX_TGZ,
      host_owned_bytes: MAX_HOST,
      build_ms: MAX_MS,
    },
    files: sourcePaths.map((p) => ({
      path: p,
      sha256: sourceHash(root, p),
      ...(p === "supply-chain.sbom.json"
        ? {
            digest_policy: "generated-SBOM-only-generated_at-excluded",
            raw_sha256: sha256(readFileSync(path.join(root, p))),
          }
        : {}),
    })),
  };
}
export function distInventory(root) {
  const expected = inventory(path.join(root, "src"))
    .filter(
      (r) => r.path.endsWith(".ts") && !r.path.endsWith(".d.ts") && !r.path.endsWith(".test.ts"),
    )
    .flatMap((r) => [".js", ".js.map", ".d.ts"].map((suffix) => r.path.slice(0, -3) + suffix))
    .sort();
  const rows = inventory(path.join(root, "dist"));
  if (
    rows.some((r) => r.symlink_target) ||
    JSON.stringify(rows.map((r) => r.path).sort()) !== JSON.stringify(expected)
  )
    throw new Error("SHIPPING_UNKNOWN_OR_MISSING_DIST");
  return rows;
}
export function publishBuildReceipt(file, value, { beforeRename } = {}) {
  if (existsSync(file)) throw new Error("SHIPPING_NEW_BUILD_RECEIPT_REQUIRED");
  const temp = `${file}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (beforeRename) beforeRename(temp);
  if (existsSync(file)) throw new Error("SHIPPING_NEW_BUILD_RECEIPT_REQUIRED");
  renameSync(temp, file); // atomic visibility; no claim of directory-fsync/power-loss durability.
}
export function assertRootReceipt(root, source = assertSource(root)) {
  const receipt = json(path.join(root, "build/npm-shipping-build-receipt.json"));
  if (
    receipt.format !== "kiwi-npm-shipping-build-receipt/1" ||
    receipt.source.source_commit !== source.source_commit ||
    receipt.source.contract_sha256 !== source.contract_sha256 ||
    JSON.stringify(receipt.source.tool) !== JSON.stringify(source.tool) ||
    !Number.isSafeInteger(receipt.started_at_ms) ||
    !Number.isSafeInteger(receipt.finished_at_ms) ||
    receipt.finished_at_ms < receipt.started_at_ms ||
    Date.now() - receipt.started_at_ms > MAX_MS ||
    receipt.verification.exit_code !== 0 ||
    JSON.stringify(receipt.verification.command) !== JSON.stringify(["npm", "run", "verify"]) ||
    receipt.verification.compiler_command !== "tsc -p tsconfig.build.json" ||
    receipt.verification.compiler_entry_sha256 !==
      sha256(readFileSync(path.join(root, "node_modules/typescript/bin/tsc"))) ||
    receipt.verification.output_sha256 !==
      sha256(readFileSync(path.join(root, "build/npm-shipping-fullverify.log"))) ||
    JSON.stringify(receipt.dist) !== JSON.stringify(distInventory(root))
  )
    throw new Error("SHIPPING_ROOT_RECEIPT_CHANGED");
  return receipt;
}
export function assertNoUnexpectedState(root) {
  return assertNoUnexpectedStateWithForeign(root, assertForeignCheckouts(root));
}
function assertNoUnexpectedStateWithForeign(root, foreign) {
  const ignored = git(root, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ":(top,glob,exclude)node_modules/**",
    ":(top,glob,exclude)build/**",
    ":(top,glob,exclude)dist/**",
  ]).split("\0");
  if (
    ignored.some(
      (p) =>
        p &&
        !isForeignPath(p, foreign) &&
        !p.startsWith("node_modules/") &&
        !p.startsWith("build/") &&
        !p.startsWith("dist/") &&
        /(^|\/)(?:\.env(?:\..*)?|\.kiwi-runtime|\.owner-host|state|credentials)(?:\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|pem|key)$/i.test(
          p,
        ),
    )
  )
    throw new Error("SHIPPING_UNTRACKED_STATE");
}
export function assertSource(root) {
  const foreign = assertForeignCheckouts(root);
  assertNoUnexpectedStateWithForeign(root, foreign);
  const contract = json(path.join(root, CONTRACT));
  if (
    contract.format !== "kiwi-npm-shipping-source/1" ||
    contract.source_base !== BASE ||
    contract.reviewed_release !== VERSION ||
    json(path.join(root, "package.json")).version !== VERSION ||
    json(path.join(root, "packages/merchant-cloud/package.json")).version !== VERSION
  )
    throw new Error("SHIPPING_SOURCE_CONTRACT_CHANGED");
  const committed = git(root, ["show", `HEAD:${CONTRACT}`]);
  if (committed !== readFileSync(path.join(root, CONTRACT), "utf8").trim())
    throw new Error("SHIPPING_UNCOMMITTED_CONTRACT");
  git(root, ["merge-base", "--is-ancestor", BASE, "HEAD"]);
  if (
    git(root, ["status", "--porcelain", "--untracked-files=normal"])
      .split("\n")
      .filter(Boolean)
      .some((row) => row.slice(3) !== "supply-chain.sbom.json" && !isForeignPath(row.slice(3), foreign))
  )
    throw new Error("SHIPPING_SOURCE_DIRTY");
  const current = sourceContractWithForeign(root, foreign);
  // Node binaries differ by platform; npm code and every tracked source remain exact.
  for (const k of ["node", "npm", "npm_cli_sha256", "npm_code_sha256"])
    if (current.tool[k] !== contract.tool[k]) throw new Error(`SHIPPING_TOOL_CHANGED ${k}`);
  if (
    JSON.stringify(
      current.files.map((r) => {
        const copy = { ...r };
        delete copy.raw_sha256;
        return copy;
      }),
    ) !==
      JSON.stringify(
        contract.files.map((r) => {
          const copy = { ...r };
          delete copy.raw_sha256;
          return copy;
        }),
      ) ||
    JSON.stringify(current.stage) !== JSON.stringify(contract.stage) ||
    JSON.stringify(current.budgets) !== JSON.stringify(contract.budgets)
  )
    throw new Error("SHIPPING_SOURCE_CHANGED");
  return {
    source_commit: git(root, ["rev-parse", "HEAD"]),
    source_base: BASE,
    contract_sha256: sha256(readFileSync(path.join(root, CONTRACT))),
    tool: current.tool,
    stage: current.stage,
  };
}
export function controlledHiddenNpmLock(stage) {
  const file = path.join(stage, "node_modules/.package-lock.json"),
    data = json(file),
    manifest = json(path.join(stage, "package.json")),
    lock = json(path.join(stage, "package-lock.json"));
  if (
    Object.keys(data).sort().join(",") !== "lockfileVersion,name,packages,requires,version" ||
    data.name !== manifest.name ||
    data.version !== manifest.version ||
    data.lockfileVersion !== 3 ||
    data.requires !== true ||
    !data.packages ||
    Array.isArray(data.packages)
  )
    throw new Error("SHIPPING_GENERATED_LOCK_INVALID");
  for (const [key, row] of Object.entries(data.packages)) {
    const declared = lock.packages[key];
    if (
      !key.startsWith("node_modules/") ||
      key.split("/").some((p) => p === ".." || !p) ||
      !declared ||
      !row ||
      json(path.join(stage, key, "package.json")).version !== declared.version
    )
      throw new Error("SHIPPING_GENERATED_LOCK_INVALID");
    for (const [field, value] of Object.entries(row)) {
      if (["dev", "devOptional", "optional"].includes(field)) {
        if (typeof value !== "boolean") throw new Error("SHIPPING_GENERATED_LOCK_INVALID");
      } else if (!Object.hasOwn(declared, field) || !same(value, declared[field]))
        throw new Error("SHIPPING_GENERATED_LOCK_INVALID");
    }
    for (const field of ["version", "resolved", "integrity"])
      if (row[field] !== declared[field]) throw new Error("SHIPPING_GENERATED_LOCK_INVALID");
  }
  for (const key of Object.keys(lock.packages))
    if (
      key &&
      existsSync(path.join(stage, key, "package.json")) &&
      !Object.hasOwn(data.packages, key)
    )
      throw new Error("SHIPPING_GENERATED_LOCK_INVALID");
  const bytes = readFileSync(file);
  return { path: "node_modules/.package-lock.json", size: bytes.length, sha256: sha256(bytes) };
}
export function assertNoState(rows, { stageNpmrc, generatedLock } = {}) {
  for (const row of rows)
    if (
      !(
        generatedLock &&
        row.path === "node_modules/.package-lock.json" &&
        row.size === generatedLock.size &&
        row.sha256 === generatedLock.sha256
      ) &&
      !(
        row.path === ".npmrc" &&
        stageNpmrc &&
        stageNpmrc.size === 278 &&
        stageNpmrc.sha256 ===
          "sha256:8230a2296fbb187ab28bb263fa048900c9939c48bf98b6ae3e45cfac2623ae39" &&
        row.size === stageNpmrc.size &&
        row.sha256 === stageNpmrc.sha256
      ) &&
      /(^|\/)(?:\.env(?:\..*)?|\.package-lock\.json|\.npmrc|\.cache|\.git|\.kiwi-runtime|\.owner-host|state|credentials)(?:\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|pem|key)$/i.test(
        row.path,
      )
    )
      throw new Error(`SHIPPING_STATE_OR_CREDENTIAL_FILE ${row.path}`);
}
export function npm(root, args, timeout = MAX_MS) {
  return execFileSync("npm", args, {
    cwd: root,
    env: { ...process.env },
    encoding: "utf8",
    maxBuffer: 64 * 1048576,
    timeout,
  });
}

/** Decode normal npm tar headers/PAX and compare the actual tgz, not merely the staging plan. */
export function verifyTarball(bytes, expectedFiles) {
  if (bytes.length >= MAX_TGZ) throw new Error("SHIPPING_TGZ_BUDGET");
  const plain = gunzipSync(bytes, { maxOutputLength: MAX_PLAIN });
  const files = new Map();
  let pax = {},
    globalPax = {},
    longPath,
    ended = false;
  const text = (buf) => buf.toString("utf8").split("\0")[0];
  for (let offset = 0; offset + 512 <= plain.length;) {
    const header = plain.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) {
      if (
        plain.length < offset + 512 ||
        plain.length % 512 !== 0 ||
        !plain.subarray(offset, offset + 512).every((b) => b === 0)
      )
        throw new Error("SHIPPING_TAR_END_BLOCKS_INVALID");
      if (!plain.subarray(offset).every((b) => b === 0))
        throw new Error("SHIPPING_TAR_TRAILING_PAYLOAD");
      ended = true;
      break;
    }
    const checksum = parseInt(text(header.subarray(148, 156)).trim(), 8);
    const actualChecksum = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== actualChecksum) throw new Error("SHIPPING_TAR_HEADER_CHECKSUM");
    const sizeText = text(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("SHIPPING_TAR_SIZE_INVALID");
    const size = parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || offset + size > plain.length)
      throw new Error("SHIPPING_TAR_TRUNCATED");
    const body = plain.subarray(offset, offset + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    if (
      offset + paddedSize > plain.length ||
      !plain.subarray(offset + size, offset + paddedSize).every((b) => b === 0)
    )
      throw new Error("SHIPPING_TAR_PADDING_INVALID");
    offset += paddedSize;
    const type = text(header.subarray(156, 157));
    if (type === "x" || type === "g") {
      const values = {};
      let pos = 0;
      while (pos < body.length) {
        const space = body.indexOf(32, pos);
        const lengthText = space < pos ? "" : body.subarray(pos, space).toString("ascii");
        if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("SHIPPING_PAX_INVALID");
        const len = Number(lengthText);
        if (
          !Number.isSafeInteger(len) ||
          len < 4 ||
          pos + len > body.length ||
          space >= pos + len - 2 ||
          body[pos + len - 1] !== 10
        )
          throw new Error("SHIPPING_PAX_INVALID");
        const lineBytes = body.subarray(space + 1, pos + len - 1);
        if (lineBytes.includes(10) || lineBytes.includes(0))
          throw new Error("SHIPPING_PAX_INVALID");
        const line = lineBytes.toString("utf8"),
          equals = line.indexOf("=");
        if (equals < 1 || !Buffer.from(line, "utf8").equals(lineBytes))
          throw new Error("SHIPPING_PAX_INVALID");
        const key = line.slice(0, equals),
          value = line.slice(equals + 1);
        if (
          !["path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"].includes(key)
        )
          throw new Error("SHIPPING_PAX_UNKNOWN_KEY");
        if (Object.hasOwn(values, key)) throw new Error("SHIPPING_PAX_DUPLICATE_KEY");
        values[key] = value;
        pos += len;
      }
      if (
        Object.keys(values).some(
          (k) =>
            !["path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"].includes(
              k,
            ),
        )
      )
        throw new Error("SHIPPING_PAX_UNKNOWN_KEY");
      if (type === "g") {
        if (Object.hasOwn(values, "path") || Object.hasOwn(values, "size"))
          throw new Error("SHIPPING_PAX_GLOBAL_BINDING");
        globalPax = { ...globalPax, ...values };
      } else {
        if (Object.keys(pax).length || longPath !== undefined)
          throw new Error("SHIPPING_PAX_AMBIGUOUS_HEADERS");
        pax = values;
      }
      continue;
    }
    if (type === "L") {
      const end = body.indexOf(0);
      if (
        longPath !== undefined ||
        Object.keys(pax).length ||
        end < 1 ||
        !body.subarray(end).every((b) => b === 0)
      )
        throw new Error("SHIPPING_TAR_LONGNAME_INVALID");
      longPath = body.subarray(0, end).toString("utf8");
      continue;
    }
    if (
      pax.size !== undefined &&
      (!/^(0|[1-9][0-9]*)$/.test(pax.size) || Number(pax.size) !== size)
    )
      throw new Error("SHIPPING_PAX_SIZE_MISMATCH");
    const prefix = text(header.subarray(345, 500));
    const name =
      pax.path ??
      globalPax.path ??
      longPath ??
      (prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100)));
    pax = {};
    longPath = undefined;
    if (
      !name.startsWith("package/") ||
      name.includes("\\") ||
      name.split("/").some((p) => p === ".." || p === ".")
    )
      throw new Error("SHIPPING_TAR_PATH_INVALID");
    if (type === "5") continue;
    if (type !== "0" && type !== "") throw new Error("SHIPPING_TAR_NONREGULAR_PAYLOAD");
    const relative = name.slice(8);
    if (files.has(relative)) throw new Error("SHIPPING_TAR_DUPLICATE");
    files.set(relative, { path: relative, size: body.length, sha256: sha256(body) });
  }
  if (!ended || Object.keys(pax).length || longPath !== undefined)
    throw new Error("SHIPPING_TAR_END_BLOCKS_INVALID");
  const rows = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const expected = [...expectedFiles].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (JSON.stringify(rows) !== JSON.stringify(expected))
    throw new Error("SHIPPING_PACK_BYTES_MISMATCH");
  return {
    compressed_bytes: bytes.length,
    plain_tar_bytes: plain.length,
    file_count: rows.length,
    sha256: sha256(bytes),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}
