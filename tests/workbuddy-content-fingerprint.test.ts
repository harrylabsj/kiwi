/**
 * 平台配置包的构建指纹：版本 + 产物 sha256，且同内容重复构建结果一致。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.join(
  root,
  "integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/build-platform-pack.mjs",
);
const config = JSON.parse(
  readFileSync(path.join(root, "integrations/hosts/workbuddy/kiwi-merchant-buddy/buddy-app.config.json"), "utf8"),
) as { version: string };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(): { out: string; fingerprint: Record<string, unknown> } {
  const base = mkdtempSync(path.join(tmpdir(), "kiwi-fingerprint-"));
  dirs.push(base);
  const out = path.join(base, "out");
  execFileSync(process.execPath, [builder, "--out", out], { encoding: "utf8" });
  return {
    out,
    fingerprint: JSON.parse(readFileSync(path.join(out, "CONTENT-FINGERPRINT.json"), "utf8")),
  };
}

const sha256 = (file: string): string =>
  `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;

describe("WorkBuddy 平台配置包构建指纹", () => {
  it("记录版本与四个产物的 sha256", () => {
    const { out, fingerprint } = build();
    expect(fingerprint).toMatchObject({
      schema: "kiwi.workbuddy.platform-pack-fingerprint.v1",
      config_version: config.version,
      source: "buddy-app.config.json",
    });
    const files = fingerprint.files as Record<string, string>;
    expect(files["industry-config.json"]).toBe(sha256(path.join(out, "industry-config.json")));
    expect(files["market.json"]).toBe(sha256(path.join(out, "market.json")));
    expect(files["platform-pack.zip"]).toBe(sha256(path.join(out, "platform-pack.zip")));
    expect(files["market-draft/market-draft.json"]).toBe(
      sha256(path.join(root, "integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/market-draft/market-draft.json")),
    );
  });

  it("同内容重复构建得到相同指纹", () => {
    const first = build().fingerprint;
    const second = build().fingerprint;
    expect(second).toEqual(first);
  });
});
