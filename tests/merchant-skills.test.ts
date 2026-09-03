import { describe, expect, it } from "vitest";
import path from "node:path";
import { SkillRegistry } from "../src/agent/skills/registry.js";
import { buildSkillTools } from "../src/agent/skills/tools.js";

const ROOT = path.resolve(process.cwd(), "skills/merchant");

describe("Merchant skills registry", () => {
  it("loads packaged merchant skills and exposes a bounded catalog", () => {
    const registry = SkillRegistry.fromDir(ROOT, "merchant");
    expect(registry.names).toEqual([
      "catalog-operations",
      "change-approval",
      "human-review",
      "inventory-operations",
      "negotiation-review",
      "performance-insights",
    ]);
    expect(registry.get("performance-insights")?.version).toBe(1);
    expect(registry.promptCatalog()).toContain("Skills cannot grant permissions");
  });

  it("loads bodies only by explicit skill name and rejects unknown skills", async () => {
    const registry = SkillRegistry.fromDir(ROOT, "merchant");
    const tool = buildSkillTools(registry)[0];
    expect(tool).toBeDefined();
    const loaded = await tool?.execute("test", { skill_name: "performance-insights" }, undefined, undefined, undefined);
    expect(loaded?.content[0]).toMatchObject({ type: "text" });
    expect((loaded?.content[0] as { text: string }).text).toContain("Performance insights");
    const missing = await tool?.execute("test", { skill_name: "missing" }, undefined, undefined, undefined);
    expect((missing?.content[0] as { text: string }).text).toContain("没有名为 missing");
  });
});
