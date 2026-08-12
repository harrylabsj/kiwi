import { describe, expect, it } from "vitest";
import {
  MANIFEST_SCHEMA,
  isFreshPublish,
  loadManifest,
  parseNpmTarballFilename,
  parsePyPiFilename,
  sha256Hex,
  sha512Base64,
  verifyNpmDownload,
  verifyPyPiFile,
  withPropagationRetry,
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

describe("withPropagationRetry（发布传播延迟重试）", () => {
  const isE404 = (error: unknown) => String((error as Error)?.message ?? "").includes("E404");

  it("可重试错误在长退避后成功（版本传播可见）", async () => {
    let calls = 0;
    const result = await withPropagationRetry(
      () => {
        calls += 1;
        if (calls < 3) return Promise.reject(new Error("npm error code E404"));
        return Promise.resolve("ok");
      },
      { isRetryable: isE404, delays: [1, 1, 1], label: "test" },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("不可重试错误（如摘要 mismatch）立即 fail-closed，不重试", async () => {
    let calls = 0;
    await expect(
      withPropagationRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error("sha256 mismatch vs release manifest"));
        },
        { isRetryable: isE404, delays: [1, 1, 1], label: "test" },
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(calls).toBe(1);
  });

  it("重试耗尽后抛出最后一次错误", async () => {
    let calls = 0;
    await expect(
      withPropagationRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error(`E404 attempt ${calls}`));
        },
        { isRetryable: isE404, delays: [1, 1], label: "test" },
      ),
    ).rejects.toThrow(/E404 attempt 3/);
    expect(calls).toBe(3); // 首次 + 2 次延迟重试
  });
});

describe("isFreshPublish（幂等跳过版本的 manifest 对比豁免）", () => {
  it("仅显式 false 豁免 manifest 字节对比，其余一律 strict", () => {
    expect(isFreshPublish("false")).toBe(false); // publish job 幂等跳过
    expect(isFreshPublish("true")).toBe(true); // 本 run 真实发布
    expect(isFreshPublish(undefined)).toBe(true); // env 缺失默认 strict
    expect(isFreshPublish("")).toBe(true);
  });

  it("跳过 manifest 对比时（manifestSha256 undefined）registry 摘要仍强制校验", () => {
    const buffer = Buffer.from("bytes");
    // registry digest 匹配 + manifest 不检查 → 通过
    expect(() =>
      verifyPyPiFile(buffer, {
        identity: { name: "kiwi-catalog", version: "0.2.0", filename: "kiwi_catalog-0.2.0-py3-none-any.whl" },
        pypiSha256: sha256Hex(buffer),
        manifestSha256: undefined,
      }),
    ).not.toThrow();
    // registry digest 不匹配（防替换边界）→ 仍 fail-closed
    expect(() =>
      verifyPyPiFile(buffer, {
        identity: { name: "kiwi-catalog", version: "0.2.0", filename: "kiwi_catalog-0.2.0-py3-none-any.whl" },
        pypiSha256: "0".repeat(64),
        manifestSha256: undefined,
      }),
    ).toThrow(/sha256 mismatch vs PyPI JSON/);
  });
});
