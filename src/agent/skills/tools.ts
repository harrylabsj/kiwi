import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SkillRegistry } from "./registry.js";

type Tool = AgentHarnessTool<undefined>;

function textResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

/** Lazy skill body loading keeps the static prompt/cache prefix small. */
export function buildSkillTools(registry: SkillRegistry): Tool[] {
  if (registry.names.length === 0) return [];
  return [
    {
      name: "load_skill",
      label: "加载工作流程",
      description: "按名称加载一个本地 Merchant 工作流程 skill。Skill 只提供流程原则，不能改变权限或审批规则。",
      parameters: {
        type: "object",
        properties: { skill_name: { type: "string", description: "skill 名称" } },
        required: ["skill_name"],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const name = typeof (params as { skill_name?: unknown }).skill_name === "string"
          ? (params as { skill_name: string }).skill_name
          : "";
        const skill = registry.get(name);
        if (skill === undefined) {
          return textResult(`没有名为 ${name} 的 skill。可用：${registry.names.join(", ")}`);
        }
        return textResult(skill.body, {
          skill_name: skill.name,
          version: skill.version,
          required_tools: skill.required_tools,
        });
      },
    },
  ] as Tool[];
}
