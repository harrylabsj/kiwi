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
 * WorkBuddy kiwi-rfq-workbench 连接器打包校验与防漂移测试（M4 私有宿主）：
 *   1. 运行 package-rfq-workbench-connector.mjs --check 断言通过；
 *   2. 同步守卫：import 真实 buildRfqMcpTools（releaseEnabled 打开）的定义，
 *      与 mcp.json 的 tools 声明做 name/description/inputSchema 全等比对
 *      （防止源码改动后连接器包漂移）；
 *   3. 三个技能（§12.3）与 tools.json 设计面文件在包内存在。
 *
 * 边界（§12.2）：本包是「自定义连接器直连商家实例 MCP」的 M4 私有试点资产；
 * 真实 WorkBuddy 实机验收仍属 L2，不因本测试宣称实机完成。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildRfqMcpTools } from "../src/mcp/merchant-rfq-tools.js";

const testsDir = import.meta.dirname;
const bundleDir = path.resolve(testsDir, "../integrations/hosts/workbuddy/kiwi-rfq-workbench");
const script = path.resolve(testsDir, "../integrations/hosts/workbuddy/package-rfq-workbench-connector.mjs");

const SKILLS = [
  "skills/rfq-intake/SKILL.md",
  "skills/quote-build-review/SKILL.md",
  "skills/quote-release-followup/SKILL.md",
] as const;

/** 真实工具注册表（发布类工具随 releaseEnabled 一起出现；surface 不参与定义）。 */
function realToolDefinitions(): ReturnType<typeof buildRfqMcpTools>["tools"] {
  return buildRfqMcpTools(undefined, { releaseEnabled: true }).tools;
}

describe("workbuddy rfq-workbench 连接器包", () => {
  it("package-rfq-workbench-connector.mjs --check 通过（14 工具 + 3 技能 + 模板域）", () => {
    const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("14 tools");
    expect(result.stdout).toContain("3 skills");
  });

  it("mcp.json 工具声明与 src/mcp/merchant-rfq-tools.ts 全等（防漂移）", () => {
    const real = realToolDefinitions();
    const mcp = JSON.parse(readFileSync(path.join(bundleDir, "mcp.json"), "utf8")) as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    expect(mcp.tools.map((t) => t.name).sort()).toEqual(real.map((t) => t.name).sort());
    for (const declared of mcp.tools) {
      const source = real.find((t) => t.name === declared.name);
      expect(source, `mcp.json 声明了源码不存在的工具 ${declared.name}`).toBeDefined();
      expect(declared.description, `${declared.name} description 漂移`).toBe(source?.description);
      expect(declared.inputSchema, `${declared.name} inputSchema 漂移`).toEqual(source?.inputSchema);
    }
    // 发布类工具在包内声明（实例侧 KIWI_RFQ_RELEASE=1 才注册；§17.2）
    expect(mcp.tools.some((t) => t.name === "kiwi_merchant_rfq_prepare_release")).toBe(true);
  });

  it("tools.json 设计面与包资产完整：3 个技能 + token schema 存在且非空", () => {
    expect(statSync(path.join(bundleDir, "tools.json")).size).toBeGreaterThan(0);
    expect(statSync(path.join(bundleDir, "token-schema.json")).size).toBeGreaterThan(0);
    for (const skill of SKILLS) {
      const full = path.join(bundleDir, skill);
      expect(existsSync(full), `缺技能文件 ${skill}`).toBe(true);
      expect(statSync(full).size).toBeGreaterThan(0);
    }
  });
});
