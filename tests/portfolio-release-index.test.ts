import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error This checked-in JavaScript release helper is intentionally tested as an ESM module.
const { buildPortfolioReleaseIndex } = await import("../scripts/build-portfolio-release-index.mjs") as {
  buildPortfolioReleaseIndex(args: { catalog: Catalog; releaseDir: string }): Promise<ReleaseIndex>;
};
const root = fileURLToPath(new URL("..", import.meta.url));
const verifier = join(root, "scripts/verify-release-manifest.mjs");
const catalog = JSON.parse(readFileSync(join(root, "portfolio-products.json"), "utf8")) as Catalog;
const tempDirs: string[] = [];

interface Product {
  id: string;
  name: string;
  version: string;
  channel: string;
  state: string;
  artifact: string | null;
  [key: string]: unknown;
}
interface Catalog {
  schema: string;
  snapshot_date: string;
  products: Product[];
}
interface ReleaseIndex {
  schema: string;
  product_count: number;
  products: Array<{ id: string; delivery: string; artifacts: Array<{ path: string; sha256: string }> }>;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-portfolio-index-"));
  tempDirs.push(dir);
  return dir;
}

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fixtureArtifacts(dir: string): void {
  for (const product of catalog.products) {
    if (product.artifact === null) continue;
    const pattern = product.artifact.slice("release/".length);
    const paths = pattern.endsWith("*")
      ? product.id === "kiwi-catalog" || product.id === "shopping-cli"
        ? [pattern.slice(0, -1) + "package.whl", pattern.slice(0, -1) + "package.tar.gz"]
        : [pattern.replace("*", "candidate.tgz")]
      : [pattern];
    for (const artifact of paths) {
      const file = join(dir, artifact);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${product.id}:${artifact}`);
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("portfolio release index", () => {
  it("indexes all eleven forms, binds available artifacts, and validates the signed file manifest", async () => {
    const release = tempDir();
    fixtureArtifacts(release);
    const index = await buildPortfolioReleaseIndex({ catalog, releaseDir: release });
    expect(index.product_count).toBe(11);
    expect(index.products.filter((product) => product.delivery === "artifact-in-bundle")).toHaveLength(9);
    expect(index.products.filter((product) => product.delivery === "external-reference-only").map((product) => product.id).sort())
      .toEqual(["kiwi-catalog-admin", "workbuddy-kiwi-sourcing-connector"]);

    const indexText = `${JSON.stringify(index, null, 2)}\n`;
    writeFileSync(join(release, "portfolio-release-index.json"), indexText);
    const files = index.products.flatMap((product) => product.artifacts.map((artifact) => artifact.path));
    files.push("portfolio-release-index.json");
    const manifestFiles = files.sort().map((path) => {
      const content = readFileSync(join(release, path), "utf8");
      return { path, sha256: sha(content) };
    });
    writeFileSync(join(release, "SHA256SUMS"), `${manifestFiles.map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`);
    writeFileSync(join(release, "release-manifest.json"), `${JSON.stringify({
      schema: "kiwi.portfolio.release-manifest.v1",
      product_index: "portfolio-release-index.json",
      files: manifestFiles,
    })}\n`);
    const result = spawnSync(process.execPath, [verifier, release], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release manifest verified:");

    const tamperedIndex = JSON.parse(readFileSync(join(release, "portfolio-release-index.json"), "utf8")) as ReleaseIndex;
    const kiwiArtifact = tamperedIndex.products.find((product) => product.id === "kiwi")!.artifacts[0]!;
    kiwiArtifact.sha256 = "0".repeat(64);
    const tamperedText = `${JSON.stringify(tamperedIndex, null, 2)}\n`;
    writeFileSync(join(release, "portfolio-release-index.json"), tamperedText);
    const tamperedFiles = manifestFiles.map((file) => file.path === "portfolio-release-index.json"
      ? { path: file.path, sha256: sha(tamperedText) }
      : file);
    writeFileSync(join(release, "SHA256SUMS"), `${tamperedFiles.map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`);
    writeFileSync(join(release, "release-manifest.json"), `${JSON.stringify({
      schema: "kiwi.portfolio.release-manifest.v1",
      product_index: "portfolio-release-index.json",
      files: tamperedFiles,
    })}\n`);
    const tampered = spawnSync(process.execPath, [verifier, release], { encoding: "utf8" });
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain(`kiwi: artifact ${kiwiArtifact.path} is missing or has a different digest`);
  });

  it("fails closed if any product declares an artifact but the bundle is missing it", async () => {
    const release = tempDir();
    fixtureArtifacts(release);
    const connector = catalog.products.find((product) => product.id === "workbuddy-merchant-connector")!;
    const artifact = connector.artifact!.slice("release/".length);
    rmSync(join(release, artifact));
    await expect(buildPortfolioReleaseIndex({ catalog, releaseDir: release }))
      .rejects.toThrow("workbuddy-merchant-connector: artifact pattern matched no files");
  });
});
