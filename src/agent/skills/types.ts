export interface SkillDefinition {
  name: string;
  version: number;
  role: "buyer" | "merchant";
  description: string;
  required_tools: string[];
  body: string;
  source_path: string;
}
