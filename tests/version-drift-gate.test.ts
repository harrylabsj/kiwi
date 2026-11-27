// Copyright 2026 harrylabsj
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/check-version-drift.mjs", import.meta.url));

function gate(sourcePath: string, responses: number[], args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-drift-test-"));
  try {
    writeFileSync(join(dir, "portfolio.lock.json"), JSON.stringify({ repositories: { "kiwi-catalog": { commit: "fixture-pin" } } }));
    writeFileSync(join(dir, "portfolio-products.json"), JSON.stringify({ products: [{
      id: "kiwi-catalog", channel: "pypi", version_source: { path: sourcePath },
    }] }));
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync('gh.log', JSON.stringify(args) + '\\n');
if (args[0] !== 'api') process.exit(2);
if (args[1] === 'repos/harrylabsj/kiwi-catalog/commits/main') console.log('fixture-pin');
else if (args[1] === 'repos/harrylabsj/kiwi-catalog/contents/pyproject.toml?ref=fixture-pin')
  console.log(Buffer.from('version = "1.2.3"').toString('base64'));
else process.exit(3);
`, { mode: 0o700 });
    writeFileSync(join(dir, "registry.mjs"), `import { appendFileSync } from 'node:fs';
const statuses = ${JSON.stringify(responses)};
globalThis.fetch = async (url, {signal}) => {
  if (!(signal instanceof AbortSignal)) throw new Error('missing timeout');
  appendFileSync('registry.log', String(url) + '\\n');
  return new Response(JSON.stringify({info: {version: '1.2.3'}}), {status: statuses.shift() ?? 500});
};
`);
    writeFileSync(join(dir, "gh.log"), "");
    writeFileSync(join(dir, "registry.log"), "");
    const result = spawnSync(process.execPath, ["--import", join(dir, "registry.mjs"), script, "--gate", ...args], {
      cwd: dir, encoding: "utf8", timeout: 10_000,
      env: { PATH: [dir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), GITHUB_STEP_SUMMARY: join(dir, "summary") },
    });
    if (result.error) throw result.error;
    return {
      status: result.status, stdout: result.stdout,
      summary: readFileSync(join(dir, "summary"), "utf8"),
      gh: readFileSync(join(dir, "gh.log"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)),
      registry: readFileSync(join(dir, "registry.log"), "utf8").split("\n").filter(Boolean),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it.each(["kiwi-catalog/pyproject.toml", "pyproject.toml"])("resolves %s at the pin's repo root and retries registry errors", sourcePath => {
  const result = gate(sourcePath, [503, 200]);
  expect(result.status).toBe(0);
  expect(result.registry).toHaveLength(2);
  expect(result.gh).toEqual([
    ["api", "repos/harrylabsj/kiwi-catalog/commits/main", "--jq", ".sha"],
    ["api", "repos/harrylabsj/kiwi-catalog/contents/pyproject.toml?ref=fixture-pin", "--jq", ".content"],
  ]);
  expect(result.stdout).toBe(result.summary);
  expect(result.stdout).toContain("无已知阻塞漂移");
});

it("reports persistent registry errors independently of drift and does not waive them", () => {
  const result = gate("pyproject.toml", [503, 503], ["--channels=npm", "--acknowledge-skips"]);
  expect(result.status).toBe(1);
  expect(result.registry).toHaveLength(2);
  expect(result.gh).toEqual([]);
  expect(result.stdout).toBe(result.summary);
  expect(result.stdout).toContain("registry kiwi-catalog: HTTP 503");
  expect(result.stdout).toContain("跳过漂移豁免不适用于执行失败");
});
