import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  dereferenceSchema,
  getValidator,
  loadSchema,
  packageRoot,
  validateAgainst,
} from "../src/contracts/schemas.js";

const FIXTURE_DIR = path.join(packageRoot(), "fixtures", "negotiation");

const PREFIX_TO_SCHEMA: Record<string, string> = {
  "decision.": "decision",
  "snapshot.": "snapshot",
  "policy-result.": "policy-result",
  "capabilities.": "capabilities",
};

function schemaFor(file: string): string {
  for (const [prefix, schema] of Object.entries(PREFIX_TO_SCHEMA)) {
    if (file.startsWith(prefix)) return schema;
  }
  throw new Error(`no schema mapping for ${file}`);
}

describe("shopping.negotiation/0.1 frozen contracts", () => {
  const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));

  it("has both valid and invalid fixtures for every schema", () => {
    for (const prefix of Object.keys(PREFIX_TO_SCHEMA)) {
      const group = fixtures.filter((f) => f.startsWith(prefix));
      expect(
        group.some((f) => f.includes(".valid.")),
        `${prefix} valid`,
      ).toBe(true);
      expect(
        group.some((f) => f.includes(".invalid-")),
        `${prefix} invalid`,
      ).toBe(true);
    }
  });

  for (const file of fixtures) {
    it(`fixture ${file}`, () => {
      const data = JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf-8"));
      const schemaName = schemaFor(file);
      const validate = getValidator(schemaName as never);
      const valid = validate(data);
      if (file.includes(".valid.")) {
        expect(validate.errors ?? [], `${file} should be valid`).toEqual([]);
        expect(valid).toBe(true);
      } else {
        expect(valid, `${file} should be rejected`).toBe(false);
      }
    });
  }

  it("every schema closes additionalProperties at every object level", () => {
    for (const name of ["decision", "snapshot", "policy-result", "capabilities"] as const) {
      const schema = loadSchema(name);
      const missing: string[] = [];
      const walk = (node: unknown, p: string): void => {
        if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${p}[${i}]`));
        if (node && typeof node === "object") {
          const obj = node as Record<string, unknown>;
          if (obj.type === "object" && obj.additionalProperties !== false) {
            missing.push(p || "/");
          }
          for (const [k, v] of Object.entries(obj)) {
            if (k !== "description") walk(v, `${p}/${k}`);
          }
        }
      };
      walk(schema, "");
      expect(missing, `${name} has open objects`).toEqual([]);
    }
  });

  it("dereferenceSchema inlines local $defs for Pi tool parameters", () => {
    const deref = dereferenceSchema(loadSchema("decision")) as Record<string, unknown>;
    expect(JSON.stringify(deref)).not.toContain("$ref");
    expect(deref.$defs).toBeUndefined();
    const proposal = (deref.properties as Record<string, Record<string, unknown>>).proposal;
    expect(proposal).toBeDefined();
    expect(proposal?.type).toBe("object");
    expect(proposal?.additionalProperties).toBe(false);
  });

  it("frozen decision example validates against the schema", () => {
    const decision = JSON.parse(
      readFileSync(path.join(FIXTURE_DIR, "decision.counter.valid.json"), "utf-8"),
    );
    expect(validateAgainst("decision", decision)).toEqual([]);
  });
});
