import { execFileSync } from "node:child_process";
import { packRecord } from "../scripts/lib/npm-pack-record.mjs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BASE,
  VERSION,
  MAX_PLAIN,
  MAX_TGZ,
  aggregate,
  assertBudget,
  assertFiles,
  assertStageLock,
  inventory,
  sourceHash,
  sourceContract,
  assertSource,
  assertOfficialNpmPayload,
  assertNoState,
  publishBuildReceipt,
  controlledHiddenNpmLock,
  verifyTarball,
  stagePackage,
} from "../scripts/lib/npm-shipping.mjs";
const root = process.cwd();
describe("current 0.12.4 full shipping contract", () => {
  it("keeps complete production declarations and unchanged locked versions/SRI", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const staged = stagePackage(root);
    expect(staged.dependencies).toEqual(pkg.dependencies);
    expect(staged.dependencies["@earendil-works/pi-coding-agent"]).toBe("1.0.2");
    expect(staged.dependencies["@simplewebauthn/server"]).toBe("14.0.2");
    expect(staged.overrides).toEqual(pkg.overrides);
    expect(staged.allowScripts).toEqual(pkg.allowScripts);
    expect(staged.scripts.preinstall).toBe(pkg.scripts.preinstall);
    expect(() => assertStageLock(root)).not.toThrow();
  });
  it("states new source and conservative gzip/plain budgets without relaxing old A243", () => {
    expect(BASE).toBe("e703bc0d67e24a98c417274e46f37d210eff86ac");
    expect(VERSION).toBe("0.12.4");
    expect(MAX_PLAIN).toBe(268435456);
    expect(MAX_TGZ).toBe(100000000);
    expect(() => assertBudget([{ size: MAX_PLAIN + 1 }])).toThrow("SHIPPING_PLAIN_BUDGET");
    const old = readFileSync(path.join(root, "scripts/a243-main-cloud-assembly.mjs"), "utf8");
    expect(old).toContain('const BASE = "45fbf556');
    expect(old).toContain("A243_MAIN_SOURCE_CHANGED");
  });
  it("recomputes every file byte and rejects extra/missing/tampered payload", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shipping-check-"));
    try {
      writeFileSync(path.join(dir, "a.js"), "original");
      const files = inventory(dir),
        m = { files, artifact_sha256: aggregate(files), file_count: files.length, total_bytes: 8 };
      expect(() => assertFiles(dir, m)).not.toThrow();
      writeFileSync(path.join(dir, "a.js"), "tampered");
      expect(() => assertFiles(dir, m)).toThrow("SHIPPING_FILES_CHANGED");
      writeFileSync(path.join(dir, "a.js"), "original");
      writeFileSync(path.join(dir, "extra.js"), "extra");
      expect(() => assertFiles(dir, m)).toThrow("SHIPPING_FILES_CHANGED");
      rmSync(path.join(dir, "extra.js"));
      rmSync(path.join(dir, "a.js"));
      expect(() => assertFiles(dir, m)).toThrow("SHIPPING_FILES_CHANGED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("only exempts generated SBOM timestamp, not dependency/artifact truth", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shipping-sbom-"));
    try {
      const file = path.join(dir, "supply-chain.sbom.json");
      const sbom = {
        sbom_version: 1,
        package: "@harrylabsj/kiwi",
        package_version: "0.12.4",
        runtime_dependencies: [],
        mcp_protocol_versions: [],
        generated_at: "2026-10-10T00:00:00.000Z",
        artifact: { name: "synthetic.tgz", sha256: "a".repeat(64), bytes: 1 },
      };
      writeFileSync(file, JSON.stringify(sbom));
      const first = sourceHash(dir, "supply-chain.sbom.json");
      writeFileSync(file, JSON.stringify({ ...sbom, generated_at: "2026-10-10T01:00:00.000Z" }));
      expect(sourceHash(dir, "supply-chain.sbom.json")).toBe(first);
      writeFileSync(file, JSON.stringify({ ...sbom, artifact: { ...sbom.artifact, bytes: 2 } }));
      expect(sourceHash(dir, "supply-chain.sbom.json")).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("immutable committed guard permits only valid top-level time drift and refuses SBOM/source/lock/helper/state drift", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shipping-source-guard-"));
    try {
      execFileSync("git", ["clone", "--no-hardlinks", root, path.join(dir, "repo")], {
        stdio: "pipe",
      });
      const repo = path.join(dir, "repo");
      for (const file of [
        "package.json",
        "package-lock.json",
        "packages/merchant-cloud/package.json",
      ])
        cpSync(path.join(root, file), path.join(repo, file));
      cpSync(
        path.join(root, "build-inputs/release0124-npm12-payload.json"),
        path.join(repo, "build-inputs/release0124-npm12-payload.json"),
      );
      cpSync(
        path.join(root, "build-inputs/release0124-stage"),
        path.join(repo, "build-inputs/release0124-stage"),
        { recursive: true },
      );
      mkdirSync(path.join(repo, "scripts/lib"), { recursive: true });
      cpSync(
        path.join(root, "scripts/lib/npm-shipping.mjs"),
        path.join(repo, "scripts/lib/npm-shipping.mjs"),
      );
      const sbomFile = path.join(repo, "supply-chain.sbom.json"),
        sbom = JSON.parse(readFileSync(sbomFile, "utf8"));
      sbom.package_version = "0.12.4";
      sbom.generated_at = "2026-10-10T00:00:00.000Z";
      writeFileSync(sbomFile, JSON.stringify(sbom, null, 2) + "\n");
      const contract = sourceContract(repo);
      writeFileSync(
        path.join(repo, "build-inputs/release0124-source.json"),
        JSON.stringify(contract, null, 2) + "\n",
      );
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Synthetic Guard Test",
          "-c",
          "user.email=synthetic@example.invalid",
          "commit",
          "-m",
          "synthetic guard fixture",
        ],
        { cwd: repo, stdio: "pipe" },
      );
      expect(() => assertSource(repo)).not.toThrow();
      writeFileSync(
        sbomFile,
        JSON.stringify({ ...sbom, generated_at: "2026-10-10T01:00:00.000Z" }, null, 2) + "\n",
      );
      expect(() => assertSource(repo)).not.toThrow();
      for (const doc of [
        { ...sbom, generated_at: "not-a-time" },
        { ...sbom, generated_at: "2026-02-31T00:00:00.000Z" },
        { ...sbom, artifact: { ...sbom.artifact, bytes: sbom.artifact.bytes + 1 } },
        { ...sbom, extra: "new" },
        { ...sbom, runtime_dependencies: [...sbom.runtime_dependencies, { name: "fake" }] },
      ]) {
        writeFileSync(sbomFile, JSON.stringify(doc, null, 2) + "\n");
        expect(() => assertSource(repo)).toThrow();
      }
      writeFileSync(sbomFile, JSON.stringify(sbom, null, 2) + "\n");
      for (const file of ["package-lock.json", "src/cli.ts", "scripts/lib/npm-shipping.mjs"]) {
        const original = readFileSync(path.join(repo, file));
        writeFileSync(
          path.join(repo, file),
          Buffer.concat([original, Buffer.from("\n# mutation")]),
        );
        expect(() => assertSource(repo)).toThrow();
        writeFileSync(path.join(repo, file), original);
      }
      writeFileSync(path.join(repo, "unexpected-state.sqlite"), "synthetic state");
      expect(() => assertSource(repo)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
  it("actual normal gzip tar bytes must match all manifest files", () => {
    const body = Buffer.from("original"),
      header = Buffer.alloc(512);
    header.write("package/a.js");
    header.write("0000644\0", 100);
    header.write("0000000010\0", 124);
    header[156] = 48;
    header.fill(32, 148, 156);
    const checksum = header.reduce((n, b) => n + b, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    const tar = Buffer.concat([header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
    const expected = [
      {
        path: "a.js",
        size: body.length,
        sha256: "sha256:" + createHash("sha256").update(body).digest("hex"),
      },
    ];
    expect(() => verifyTarball(gzipSync(tar), expected)).not.toThrow();
    const changed = Buffer.from(tar);
    changed[512] = 84;
    expect(() => verifyTarball(gzipSync(changed), expected)).toThrow(
      "SHIPPING_PACK_BYTES_MISMATCH",
    );
    expect(() => verifyTarball(gzipSync(tar), [])).toThrow("SHIPPING_PACK_BYTES_MISMATCH");
  });
  it("strict one-record adapter accepts official npm12 keyed records and refuses ambiguous or unsafe output", () => {
    const record = {
      name: "@harrylabsj/kiwi",
      version: "0.12.4",
      filename: "harrylabsj-kiwi-0.12.4.tgz",
      integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64"),
      size: 10,
      unpackedSize: 20,
      files: [{ path: "package.json", size: 20 }],
    };
    const expected = { name: record.name, version: record.version };
    expect(packRecord([record], expected)).toEqual(record);
    expect(packRecord({ [record.name]: record }, expected)).toEqual(record);
    for (const value of [
      [],
      {},
      [record, record],
      { wrong: record },
      { [record.name]: { ...record, version: "0.12.3" } },
      { [record.name]: { ...record, filename: "../escape.tgz" } },
      { [record.name]: { ...record, files: [] } },
      { [record.name]: { ...record, files: [{ path: "../escape", size: 1 }] } },
      { [record.name]: { ...record, integrity: "sha512-fake" } },
    ])
      expect(() => packRecord(value, expected)).toThrow();
  });
  it("canonical official npm payload passes without Corepack and rejects any original byte or unknown extra", () => {
    const payload = JSON.parse(
      readFileSync(path.join(root, "build-inputs/release0124-npm12-payload.json"), "utf8"),
    );
    const temp = mkdtempSync(path.join(tmpdir(), "shipping-npm-official-"));
    try {
      const tool = path.join(temp, "npm");
      const launcher = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
      const actualRoot = path.resolve(path.dirname(realpathSync(launcher)), "..");
      cpSync(actualRoot, tool, { recursive: true });
      expect(() => assertOfficialNpmPayload(tool, payload)).not.toThrow();
      rmSync(path.join(tool, ".corepack"));
      expect(() => assertOfficialNpmPayload(tool, payload)).not.toThrow();
      const file = path.join(tool, "lib/cli.js"),
        original = readFileSync(file);
      writeFileSync(file, Buffer.concat([original, Buffer.from("\n// changed")]));
      expect(() => assertOfficialNpmPayload(tool, payload)).toThrow("PAYLOAD_CHANGED");
      writeFileSync(file, original);
      writeFileSync(path.join(tool, "unknown.js"), "unknown");
      expect(() => assertOfficialNpmPayload(tool, payload)).toThrow("PAYLOAD_CHANGED");
      rmSync(path.join(tool, "unknown.js"));
      writeFileSync(
        path.join(tool, ".corepack"),
        JSON.stringify({
          locator: { name: "npm", reference: "12.0.2" },
          bin: { npm: "./bin/npm-cli.js", npx: "./bin/npx-cli.js" },
          hash: "sha512." + "0".repeat(128),
        }),
      );
      expect(() => assertOfficialNpmPayload(tool, payload)).toThrow("LOCATOR_INVALID");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it("no node_modules state exemption and stage npmrc only permits exact credential-free baseline bytes", () => {
    const hash = (b: Buffer) => "sha256:" + createHash("sha256").update(b).digest("hex");
    for (const path of [
      "node_modules/unknown/.env",
      "node_modules/unknown/state/private.sqlite",
      ".npmrc",
    ])
      expect(() => assertNoState([{ path, size: 1, sha256: hash(Buffer.from("x")) }])).toThrow();
    const plain = readFileSync(path.join(root, ".npmrc"));
    const allowed = { size: plain.length, sha256: hash(plain) };
    expect(() =>
      assertNoState([{ path: ".npmrc", ...allowed }], { stageNpmrc: allowed }),
    ).not.toThrow();
    for (const text of ["_authToken=synthetic-not-real\n", "registry=https://unknown.invalid\n"]) {
      const b = Buffer.from(text);
      expect(() =>
        assertNoState([{ path: ".npmrc", size: b.length, sha256: hash(b) }], {
          stageNpmrc: allowed,
        }),
      ).toThrow();
    }
  });
  it("build receipt becomes visible only after full file sync and rename; faults preserve existing receipt", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shipping-atomic-receipt-")),
      file = path.join(dir, "receipt.json");
    try {
      expect(() =>
        publishBuildReceipt(
          file,
          { ok: true },
          {
            beforeRename: () => {
              throw new Error("synthetic-before-rename");
            },
          },
        ),
      ).toThrow("synthetic-before-rename");
      expect(existsSync(file)).toBe(false);
      publishBuildReceipt(file, { ok: true });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ok: true });
      const original = readFileSync(file);
      expect(() => publishBuildReceipt(file, { different: true })).toThrow(
        "NEW_BUILD_RECEIPT_REQUIRED",
      );
      expect(readFileSync(file)).toEqual(original);
      rmSync(file);
      writeFileSync(file, "old malformed receipt");
      expect(() => publishBuildReceipt(file, { ok: true })).toThrow("NEW_BUILD_RECEIPT_REQUIRED");
      expect(readFileSync(file, "utf8")).toBe("old malformed receipt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("hidden install lock is only admitted after exact stage identity and original locked metadata checks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shipping-generated-lock-"));
    try {
      mkdirSync(path.join(dir, "node_modules/demo"), { recursive: true });
      const row = {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz",
        integrity: "sha512-synthetic",
      };
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "synthetic-stage", version: "0.12.4" }),
      );
      writeFileSync(
        path.join(dir, "package-lock.json"),
        JSON.stringify({ packages: { "node_modules/demo": row } }),
      );
      writeFileSync(
        path.join(dir, "node_modules/demo/package.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      const file = path.join(dir, "node_modules/.package-lock.json"),
        doc = {
          name: "synthetic-stage",
          version: "0.12.4",
          requires: true,
          lockfileVersion: 3,
          packages: { "node_modules/demo": row },
        };
      writeFileSync(file, JSON.stringify(doc));
      const generated = controlledHiddenNpmLock(dir);
      expect(() => assertNoState([generated])).toThrow();
      expect(() => assertNoState([generated], { generatedLock: generated })).not.toThrow();
      writeFileSync(
        file,
        JSON.stringify({
          ...doc,
          packages: { "node_modules/demo": { ...row, _authToken: "synthetic" } },
        }),
      );
      expect(() => controlledHiddenNpmLock(dir)).toThrow("GENERATED_LOCK_INVALID");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("tar requires complete aligned end blocks and unambiguous newline-terminated PAX lengths", () => {
    const body = Buffer.from("original"),
      expected = [
        {
          path: "a.js",
          size: 8,
          sha256: "sha256:" + createHash("sha256").update(body).digest("hex"),
        },
      ];
    const entry = (name: string, b: Buffer, type = "0") => {
      const h = Buffer.alloc(512);
      h.write(name);
      h.write(b.length.toString(8).padStart(11, "0") + "\0", 124);
      h.fill(32, 148, 156);
      h.write(type, 156);
      h.write(
        h
          .reduce((n, v) => n + v, 0)
          .toString(8)
          .padStart(6, "0") + "\0 ",
        148,
      );
      return Buffer.concat([h, b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
    };
    const normal = entry("package/a.js", body);
    for (const tail of [Buffer.alloc(0), Buffer.alloc(512), Buffer.from("unframed")])
      expect(() => verifyTarball(gzipSync(Buffer.concat([normal, tail])), expected)).toThrow();
    const line = (value: string) => {
      let n = 1;
      for (;;) {
        const text = `${n} ${value}\n`;
        if (Buffer.byteLength(text) === n) return Buffer.from(text);
        n = Buffer.byteLength(text);
      }
    };
    const valid = line("path=package/a.js"),
      target = entry("package/short", body);
    expect(() =>
      verifyTarball(
        gzipSync(Buffer.concat([entry("Pax", valid, "x"), target, Buffer.alloc(1024)])),
        expected,
      ),
    ).not.toThrow();
    const badNewline = Buffer.from(valid);
    badNewline[badNewline.length - 1] = 88;
    for (const pax of [
      badNewline,
      Buffer.concat([valid, valid]),
      Buffer.from("99 path=package/a.js\n"),
      Buffer.from("+21 path=package/a.js\n"),
      line("__proto__=bad"),
    ])
      expect(() =>
        verifyTarball(
          gzipSync(Buffer.concat([entry("Pax", pax, "x"), target, Buffer.alloc(1024)])),
          expected,
        ),
      ).toThrow();
  });
});
