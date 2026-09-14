/**
 * WorkBuddy kiwi-merchant-connector 打包校验与防漂移测试（阶段三）：
 * 1. 运行 package-merchant-connector.mjs --check 断言通过；
 * 2. 同步守卫：import 真实 buildMerchantMcpTools 的定义，与 mcp.json 的
 *    tools 声明做 name/description/inputSchema 全等比对（防止源码改动后
 *    连接器包漂移）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { MerchantWorkbenchService } from "../src/merchant/workbench-service.js";
import { buildMerchantMcpTools } from "../src/mcp/merchant-tools.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-08-05T12:00:00+08:00";
const BUNDLE = path.resolve(__dirname, "../integrations/hosts/workbuddy/kiwi-merchant-connector");
const SCRIPT = path.resolve(
  __dirname,
  "../integrations/hosts/workbuddy/package-merchant-connector.mjs",
);

function realToolDefinitions(): ReturnType<typeof buildMerchantMcpTools>["tools"] {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run("merchant-agent:merchant-001", T0, T0);
  try {
    const service = new MerchantWorkbenchService({
      profile: testProfile(),
      merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
      approvals: new WriteApprovalCandidateStore({
        db,
        principalId: "merchant-agent:merchant-001",
        now: () => T0,
      }),
      mode: () => "supervised",
      now: () => T0,
    });
    return buildMerchantMcpTools(service).tools;
  } finally {
    db.close();
  }
}

describe("workbuddy merchant connector 包", () => {
  it("package-merchant-connector.mjs --check 通过", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("7 tools");
  });

  it("mcp.json 工具声明与 src/mcp/merchant-tools.ts 全等（防漂移）", () => {
    const mcp = JSON.parse(readFileSync(path.join(BUNDLE, "mcp.json"), "utf8")) as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    const real = realToolDefinitions();
    expect(mcp.tools.map((t) => t.name).sort()).toEqual(real.map((t) => t.name).sort());
    for (const declared of mcp.tools) {
      const source = real.find((t) => t.name === declared.name);
      expect(source, `mcp.json 声明了源码不存在的工具 ${declared.name}`).toBeDefined();
      expect(declared.description).toBe(source?.description);
      expect(declared.inputSchema).toEqual(source?.inputSchema);
    }
  });
});
