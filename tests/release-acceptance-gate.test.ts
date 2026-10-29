/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 发布前提：端到端验收回执必须存在、新鲜、四段链路全 ok，且版本与本仓一致。
 * 门禁是 fail-closed 的——缺回执、过期、某段失败、版本漂移都必须拒绝发布。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const script = path.join(root, "scripts/verify-release-acceptance.mjs");
const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
const shoppingPin = (
  JSON.parse(readFileSync(path.join(root, "portfolio.lock.json"), "utf8")) as {
    repositories: Record<string, { commit: string }>;
  }
).repositories["shopping-cli"]?.commit;

const GOOD_HANDOFF = {
  destination_type: "external_checkout_url",
  url: "https://item.jd.com/100012043978.html",
};

function receipt(overrides: Record<string, unknown> = {}, chainOverrides: Record<string, unknown> = {}) {
  return {
    schema: "kiwi.release-acceptance/1",
    recorded_at: new Date().toISOString(),
    kiwi_version: version,
    shopping_cli_commit: shoppingPin,
    chain: {
      search: { ok: true, detail: "hit" },
      quote: { ok: true, detail: "quoted" },
      agreement: { ok: true, detail: "non-binding" },
      handoff: { ok: true, detail: "url", ...GOOD_HANDOFF },
      ...chainOverrides,
    },
    ...overrides,
  };
}

function run(value: unknown): { ok: boolean; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-acceptance-"));
  try {
    const file = path.join(dir, "receipt.json");
    writeFileSync(file, JSON.stringify(value));
    try {
      const output = execFileSync(process.execPath, [script, "--file", file], { encoding: "utf8", stdio: "pipe" });
      return { ok: true, output };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("release acceptance gate", () => {
  it("accepts a fresh, complete receipt for the version being released", () => {
    const result = run(receipt());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("release acceptance OK");
  });

  it("rejects a stale receipt", () => {
    const old = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
    const result = run(receipt({ recorded_at: old }));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("回执已过期");
  });

  it("rejects a chain with a failed step", () => {
    const result = run(receipt({}, { quote: { ok: false, detail: "merchant_declined:field_unsupported" } }));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("链路阶段 quote 未通过");
  });

  it("rejects a handoff without a trade entry url", () => {
    const result = run(receipt({}, { handoff: { ok: true, destination_type: "external_checkout_url", url: "" } }));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("没有 url");
  });

  it("rejects a receipt recorded for another kiwi version", () => {
    const result = run(receipt({ kiwi_version: "0.0.1" }));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("与当前仓库");
  });

  it("rejects a missing receipt", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-acceptance-"));
    try {
      const missing = path.join(dir, "nope.json");
      let failed = false;
      try {
        execFileSync(process.execPath, [script, "--file", missing], { encoding: "utf8", stdio: "pipe" });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
