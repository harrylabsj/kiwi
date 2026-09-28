import { createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const prepareSource = path.resolve("packages/merchant-cloud/prepare.mjs");

function fixture(): { root: string; out: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "kiwi-cloud-package-"));
  roots.push(root);
  const pkg = path.join(root, "package");
  const out = path.join(root, "deploy");
  const cloudSample = path.join(pkg, "app", "cloud-sample");
  const app = path.join(pkg, "app", "cloud");
  const contracts = path.join(pkg, "contracts");
  const nodeModules = path.join(pkg, "node_modules");
  const prepare = path.join(pkg, "prepare.mjs");
  const files = [cloudSample, app, contracts, nodeModules];
  for (const dir of files) mkdirSync(dir, { recursive: true });
  cpSync(prepareSource, prepare);
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "fixture", version: "0.11.0", type: "module" }));
  writeFileSync(path.join(app, "main.js"), "fixture\n");
  writeFileSync(path.join(cloudSample, "merchant.yaml"), "agent_id: merchant-agent:test\nowner_id: merchant-test\n");
  writeFileSync(path.join(cloudSample, "products.json"), JSON.stringify({
    schema_version: "0.1.2", merchant_id: "merchant-test", source: "test_fixture", generated_at: new Date().toISOString(),
    products: [{ sku: "smoke-sku-1", title: "Smoke", currency: "CNY", unit: "piece", price: 10,
      updated_at: new Date().toISOString(), valid_until: new Date(Date.now() + 60_000).toISOString(), status: "active", test: true }],
  }));
  const tracked = [path.join(pkg, "package.json"), prepare, path.join(app, "main.js"), path.join(cloudSample, "merchant.yaml"), path.join(cloudSample, "products.json")];
  const manifestFiles = tracked.map((file) => ({
    path: path.relative(pkg, file).split(path.sep).join("/"),
    size: readFileSync(file).length,
    sha256: `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`,
  }));
  const aggregate = `sha256:${createHash("sha256").update(manifestFiles.map((item) => `${item.path}\0${item.sha256}`).sort().join("\n")).digest("hex")}`;
  writeFileSync(path.join(pkg, "build-manifest.json"), JSON.stringify({ runtime_version: "0.11.0", artifact_sha256: aggregate, files: manifestFiles }));
  return { root: pkg, out };
}

function run(pkg: string, out: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(pkg, "prepare.mjs"), "--origin", "https://merchant.example", "--out", out, ...args], { encoding: "utf8" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("merchant cloud package prepare", () => {
  it.each(["http://merchant.example", "https://merchant.example/path", "https://merchant.example?x=1", "https://merchant.example?", "https://merchant.example#", "https://user:pass@merchant.example"]) (
    "rejects unsafe origin %s", (origin) => {
      const { root, out } = fixture();
      const result = spawnSync(process.execPath, [path.join(root, "prepare.mjs"), "--origin", origin, "--out", out], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
    },
  );

  it("rejects file changes that disagree with the aggregate manifest", () => {
    const { root, out } = fixture();
    writeFileSync(path.join(root, "app", "cloud", "main.js"), "tampered\n");
    const result = run(root, out);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("制品摘要不一致");
  });

  it("generates a unique runtime identity and an empty persistent production product table", () => {
    const { root, out } = fixture();
    const firstOut = path.join(path.dirname(out), "deploy-first");
    const first = run(root, firstOut);
    const second = run(root, out);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const firstReceipt = JSON.parse(first.stdout.split("\n")[0] ?? "{}");
    const secondReceipt = JSON.parse(second.stdout.split("\n")[0] ?? "{}");
    expect(firstReceipt.agent_id).not.toBe(secondReceipt.agent_id);
    expect(firstReceipt.sample).toBe(false);
    expect(firstReceipt.catalog_url).toBe("https://catalog.kiwi.harrylabsj.com");
    const profile = readFileSync(path.join(out, "pilot", "merchant.yaml"), "utf8");
    expect(profile).toContain(`agent_id: ${secondReceipt.agent_id}`);
    const config = JSON.parse(readFileSync(path.join(out, "cloud.config.json"), "utf8"));
    expect(config.products_file).toBe("/workspace/.kiwi-runtime/products.json");
    expect(existsSync(path.join(out, "pilot", "products.json"))).toBe(false);
    expect(existsSync(path.join(out, "app", "cloud-sample"))).toBe(false);
    expect(config.merchant_name_needs_update).toBe(true);
  });

  it("requires HTTPS Catalog; loopback HTTP needs the explicit flag and sample rejects production", () => {
    const { root, out } = fixture();
    expect(run(root, out, "--catalog-url", "http://catalog.example").status).not.toBe(0);
    expect(run(root, out, "--catalog-url", "http://127.0.0.1:8123").status).not.toBe(0);
    expect(run(root, out, "--catalog-url", "not-a-url").status).not.toBe(0);
    const localOut = path.join(path.dirname(out), "sample-local");
    const local = run(root, localOut, "--sample", "--catalog-url", "http://127.0.0.1:8123", "--allow-insecure-catalog");
    expect(local.status).toBe(0);
    const receipt = JSON.parse(local.stdout.split("\n")[0] ?? "{}");
    expect(receipt.sample).toBe(true);
    expect(receipt.allow_insecure_catalog).toBe(true);
    const config = JSON.parse(readFileSync(path.join(localOut, "cloud.config.json"), "utf8"));
    const products = JSON.parse(readFileSync(path.join(localOut, "pilot", "products.json"), "utf8"));
    expect(config.sample).toBe(true);
    expect(config.allow_insecure_catalog).toBe(true);
    expect(products.products[0]?.test).toBe(true);
    expect(products.merchant_id).toBe(receipt.agent_id.replace("merchant-agent:", ""));
    expect(run(root, path.join(path.dirname(out), "sample-prod"), "--sample").status).not.toBe(0);
  });

  it("writes a non-sensitive config and only an scrypt hash for bootstrap", () => {
    const { root, out } = fixture();
    const result = run(root, out, "--admin-bootstrap");
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout.split("\n")[0] ?? "{}");
    expect(receipt).toMatchObject({ deployment_dir: out, version: "0.11.0", sample: false });
    expect(Object.keys(receipt).sort()).toEqual(["agent_id", "allow_insecure_catalog", "artifact_sha256", "catalog_url", "deployment_dir", "sample", "version"].sort());
    const config = JSON.parse(readFileSync(path.join(out, "cloud.config.json"), "utf8"));
    expect(config.public_origin).toBe("https://merchant.example");
    expect(JSON.stringify(config)).not.toMatch(/password|token|secret/i);
    expect(config.catalog_url).toBe("https://catalog.kiwi.harrylabsj.com");
    expect(config.merchant_name_needs_update).toBe(true);
    const passwordLine = result.stdout.split("\n").find((line) => line.startsWith("一次性管理员口令"));
    expect(passwordLine).toBeTruthy();
    const password = passwordLine!.split("：")[1]!;
    const bootstrap = JSON.parse(readFileSync(path.join(out, "admin-bootstrap.json"), "utf8"));
    expect(bootstrap.principal_id).toBe(receipt.agent_id);
    expect(bootstrap.password_hash).toMatch(/^scrypt\$16384\$/);
    expect(JSON.stringify(bootstrap)).not.toContain(password);
    const [, n, salt, encoded] = bootstrap.password_hash.split("$");
    const actual = scryptSync(password, salt!, 32, { N: Number(n) });
    expect(timingSafeEqual(actual, Buffer.from(encoded!, "base64url"))).toBe(true);
    expect(existsSync(path.join(root, "admin-bootstrap.json"))).toBe(false);
  });

  it("accepts an explicit merchant display name and marks it configured", () => {
    const { root, out } = fixture();
    const result = run(root, out, "--merchant-name", "Acme 商贸");
    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(path.join(out, "cloud.config.json"), "utf8"));
    const profile = readFileSync(path.join(out, "pilot", "merchant.yaml"), "utf8");
    expect(config.merchant_name_needs_update).toBe(false);
    expect(profile).toContain('name: "Acme 商贸"');
  });
});
