/**
 * WP0：买方工具契约冻结（已发布连接器 `oc_bd73f860e3e2b5d3` / `kiwi-sourcing`）。
 *
 * 买方连接器是**本地 stdio、已发布 v1.0.0**，已安装用户依赖其工具名称与入参：
 * 平台分发包的 Skill 明确列出九个工具（见
 * docs/merchant-buddy/workbuddy-connector-platform-verification-2026-09-17.md §2）。
 *
 * 本测试把这些工具的**名称与 inputSchema**逐字冻结在
 * `tests/fixtures/buyer-tool-contract.json`：任何"顺手改一下参数"都会在这里被拦下。
 * 新增能力必须以**增量工具**交付（第 0 版的关注三件套就是先例），且买方侧改动走
 * 独立版本与回归，不随商家连接器一起发布。
 *
 * 注意：这里只冻结**输入契约**——输出结构由 buyer-core 的行为测试与
 * `tests/merchant-publications-m0.test.ts` 等覆盖。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildKiwiTools } from "../src/mcp/tools.js";

interface FrozenTool {
  name: string;
  inputSchema: unknown;
}

const fixturePath = path.join(process.cwd(), "tests/fixtures/buyer-tool-contract.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  tools: FrozenTool[];
};

/** 已发布连接器的工具集合（九件套；新增工具不在此列）。 */
const PUBLISHED_TOOLS = fixture.tools.map((tool) => tool.name);

function toolsByName(): Map<string, { name: string; inputSchema: unknown }> {
  const tools = buildKiwiTools({} as never) as Array<{ name: string; inputSchema: unknown }>;
  return new Map(
    tools.map((tool) => [tool.name, { name: tool.name, inputSchema: tool.inputSchema }]),
  );
}

describe("买方已发布工具契约（冻结）", () => {
  it("九个已发布工具仍存在，且 inputSchema 与基线逐字一致", () => {
    expect(PUBLISHED_TOOLS).toHaveLength(9);
    const current = toolsByName();
    for (const frozen of fixture.tools) {
      const tool = current.get(frozen.name);
      expect(tool, `已发布工具缺失：${frozen.name}`).toBeDefined();
      expect(tool?.inputSchema, `工具入参契约被改动：${frozen.name}`).toEqual(frozen.inputSchema);
    }
  });

  it("基线里没有多余工具（新增能力必须是增量，不能改名冒名）", () => {
    expect(new Set(PUBLISHED_TOOLS).size).toBe(PUBLISHED_TOOLS.length);
    expect([...PUBLISHED_TOOLS].sort()).toEqual(
      [
        "kiwi_accept_agreement",
        "kiwi_approve",
        "kiwi_get_agreement",
        "kiwi_get_task",
        "kiwi_handoff",
        "kiwi_negotiate",
        "kiwi_reject",
        "kiwi_request_quotes",
        "kiwi_search",
      ].sort(),
    );
  });

  it("第 0 版新增的买方能力以增量工具交付（不挤占已发布工具）", () => {
    const current = toolsByName();
    for (const additive of [
      "kiwi_follow_merchant",
      "kiwi_unfollow_merchant",
      "kiwi_list_follows",
      "kiwi_get_follow_updates",
    ]) {
      expect(current.has(additive), `增量工具缺失：${additive}`).toBe(true);
      expect(PUBLISHED_TOOLS).not.toContain(additive);
    }
  });
});

describe("买方连接器身份（不随商家连接器改变）", () => {
  it("采购专家使用桌面端可解析的买方 source，而非开放平台资产 ID", () => {
    const pluginPath = path.join(
      process.cwd(),
      "integrations/hosts/workbuddy/kiwi-procurement-expert/.codebuddy-plugin/plugin.json",
    );
    const plugin = JSON.parse(readFileSync(pluginPath, "utf8")) as {
      dependencies?: { connectors?: string[] };
    };
    // WorkBuddy 5.6.0 getConnectorConfigById matches entry.source || entry.name.
    // The published asset ID oc_bd73f860e3e2b5d3 is for platform management only.
    const publishedEntries = [{ source: "kiwi-sourcing", name: "Kiwi 采购询价" }];
    expect(plugin.dependencies?.connectors).toEqual(["kiwi-sourcing"]);
    for (const configId of plugin.dependencies?.connectors ?? []) {
      expect(
        publishedEntries.find((entry) => (entry.source || entry.name) === configId),
      ).toBeDefined();
    }
  });

  it("商家连接器包不声明买方工具，也不指向买方 source", () => {
    const merchantMeta = JSON.parse(
      readFileSync(
        path.join(
          process.cwd(),
          "integrations/hosts/workbuddy/kiwi-merchant-gateway-connector/connector-meta.json",
        ),
        "utf8",
      ),
    ) as { source: string };
    expect(merchantMeta.source).toBe("kiwi-merchant");
    expect(merchantMeta.source).not.toBe("kiwi-sourcing");

    const merchantMcp = JSON.parse(
      readFileSync(
        path.join(
          process.cwd(),
          "integrations/hosts/workbuddy/kiwi-merchant-gateway-connector/mcp.json",
        ),
        "utf8",
      ),
    ) as { tools: Array<{ name: string }> };
    for (const tool of merchantMcp.tools) {
      expect(PUBLISHED_TOOLS).not.toContain(tool.name);
    }
  });
});
