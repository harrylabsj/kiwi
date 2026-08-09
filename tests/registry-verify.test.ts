import { describe, expect, it } from "vitest";
import {
  MANIFEST_SCHEMA,
  loadManifest,
  parseNpmTarballFilename,
  parsePyPiFilename,
  sha256Hex,
  sha512Base64,
  verifyNpmDownload,
  verifyPyPiFile,
} from "../scripts/lib/registry-verify.mjs";

describe("registry-verify pure helpers", () => {
  it("computes sha256 and sha512 digests", () => {
    const buffer = Buffer.from("kiwi");
    expect(sha256Hex(buffer)).toBe(
      "1a5afeda973d776e31d1d7266f184468f84d99bed311d88d3dcb67015934f9f9",
    );
    expect(sha512Base64(buffer)).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("parses PyPI wheel filenames", () => {
    expect(parsePyPiFilename("kiwi_catalog-0.1.0-py3-none-any.whl")).toEqual({
      name: "kiwi-catalog",
      version: "0.1.0",
      kind: "wheel",
    });
    expect(parsePyPiFilename("shopping_cli-3.0.1-py3-none-any.whl")).toEqual({
      name: "shopping-cli",
      version: "3.0.1",
      kind: "wheel",
    });
  });

  it("parses PyPI sdist filenames", () => {
    expect(parsePyPiFilename("kiwi_catalog-0.1.0.tar.gz")).toEqual({
      name: "kiwi-catalog",
      version: "0.1.0",
      kind: "sdist",
    });
    expect(parsePyPiFilename("shopping_cli-3.0.1.tar.gz")).toEqual({
      name: "shopping-cli",
      version: "3.0.1",
      kind: "sdist",
    });
  });

  it("rejects malformed PyPI filenames", () => {
    expect(() => parsePyPiFilename("not-a-wheel.whl")).toThrow();
    expect(() => parsePyPiFilename("no-version.tar.gz")).toThrow();
    expect(() => parsePyPiFilename("random.txt")).toThrow();
  });

  it("parses npm tarball filenames (scoped and unscoped)", () => {
    expect(parseNpmTarballFilename("harrylabsj-kiwi-0.6.1.tgz")).toEqual({
      name: "@harrylabsj/kiwi",
      version: "0.6.1",
    });
    expect(parseNpmTarballFilename("lodash-4.17.21.tgz")).toEqual({
      name: "lodash",
      version: "4.17.21",
    });
  });

  it("rejects malformed npm tarball filenames", () => {
    expect(() => parseNpmTarballFilename("not-a-tarball.zip")).toThrow();
    expect(() => parseNpmTarballFilename("onlyname.tgz")).toThrow();
  });

  it("verifyNpmDownload fails closed on integrity mismatch", () => {
    const buffer = Buffer.from("bytes");
    expect(() =>
      verifyNpmDownload(buffer, {
        identity: { name: "@harrylabsj/kiwi", version: "0.6.1" },
        integrity: "sha512-Zm9hZGF9X0GvYpL4U1fZ1G0a==",
        sha256: sha256Hex(buffer),
      }),
    ).toThrow(/integrity mismatch/);
  });

  it("verifyNpmDownload fails closed on manifest sha256 mismatch", () => {
    const buffer = Buffer.from("bytes");
    expect(() =>
      verifyNpmDownload(buffer, {
        identity: { name: "@harrylabsj/kiwi", version: "0.6.1" },
        integrity: `sha512-${sha512Base64(buffer)}`,
        sha256: "0".repeat(64),
      }),
    ).toThrow(/sha256 mismatch vs release manifest/);
  });

  it("verifyNpmDownload accepts matching digests", () => {
    const buffer = Buffer.from("bytes");
    expect(() =>
      verifyNpmDownload(buffer, {
        identity: { name: "@harrylabsj/kiwi", version: "0.6.1" },
        integrity: `sha512-${sha512Base64(buffer)}`,
        sha256: sha256Hex(buffer),
      }),
    ).not.toThrow();
  });

  it("verifyPyPiFile fails closed on PyPI digest mismatch", () => {
    const buffer = Buffer.from("bytes");
    expect(() =>
      verifyPyPiFile(buffer, {
        identity: { name: "kiwi-catalog", version: "0.1.0", filename: "kiwi_catalog-0.1.0-py3-none-any.whl" },
        pypiSha256: "0".repeat(64),
        manifestSha256: sha256Hex(buffer),
      }),
    ).toThrow(/sha256 mismatch vs PyPI JSON/);
  });

  it("verifyPyPiFile fails closed on manifest sha256 mismatch", () => {
    const buffer = Buffer.from("bytes");
    expect(() =>
      verifyPyPiFile(buffer, {
        identity: { name: "kiwi-catalog", version: "0.1.0", filename: "kiwi_catalog-0.1.0-py3-none-any.whl" },
        pypiSha256: sha256Hex(buffer),
        manifestSha256: "0".repeat(64),
      }),
    ).toThrow(/sha256 mismatch vs release manifest/);
  });

  it("verifyPyPiFile accepts matching digests", () => {
    const buffer = Buffer.from("bytes");
    expect(() =>
      verifyPyPiFile(buffer, {
        identity: { name: "kiwi-catalog", version: "0.1.0", filename: "kiwi_catalog-0.1.0-py3-none-any.whl" },
        pypiSha256: sha256Hex(buffer),
        manifestSha256: sha256Hex(buffer),
      }),
    ).not.toThrow();
  });

  it("loadManifest accepts the portfolio schema and rejects others", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "kiwi-registry-test-"));
    await writeFile(
      join(dir, "release-manifest.json"),
      JSON.stringify({ schema: MANIFEST_SCHEMA, contract_source_commit: "0".repeat(40), files: [] }),
    );
    await expect(loadManifest(dir)).resolves.toMatchObject({ schema: MANIFEST_SCHEMA, files: [] });

    await writeFile(join(dir, "release-manifest.json"), JSON.stringify({ schema: "other", files: [] }));
    await expect(loadManifest(dir)).rejects.toThrow(/unsupported release manifest/);
  });
});
