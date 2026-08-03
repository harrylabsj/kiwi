/**
 * Loading and validation of the frozen shopping.negotiation/0.1 JSON schemas.
 *
 * The JSON files under contracts/shopping.negotiation/0.1/ are the single
 * source of truth, shared with the Python side (scripts/validate_fixtures.py).
 * Tool parameter schemas handed to Pi are derived from the same files by
 * inlining local $defs, so the model-facing contract can never drift from
 * the frozen contract.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Type } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

// ajv is CommonJS; under NodeNext + verbatimModuleSyntax a default import
// does not yield the callable export, so load it explicitly.
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as new (opts?: {
  allErrors?: boolean;
  strict?: boolean;
}) => Ajv2020Type;
const addFormats = require("ajv-formats") as (ajv: Ajv2020Type) => unknown;

const CONTRACT_DIR = ["contracts", "shopping.negotiation", "0.1"] as const;

export type SchemaName = "decision" | "snapshot" | "policy-result" | "capabilities";

/** Resolve the repository/package root from this module's location. */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/contracts/schemas.js -> <root>; src/contracts/schemas.ts -> <root>
  return path.resolve(here, "..", "..");
}

export function contractDir(): string {
  return path.join(packageRoot(), ...CONTRACT_DIR);
}

const cache = new Map<SchemaName, Record<string, unknown>>();

export function loadSchema(name: SchemaName): Record<string, unknown> {
  const hit = cache.get(name);
  if (hit) return hit;
  const file = path.join(contractDir(), `${name}.schema.json`);
  const schema = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  cache.set(name, schema);
  return schema;
}

/**
 * Inline local "#/$defs/..." references. Pi validates tool arguments with
 * TypeBox, which does not resolve $ref; the frozen schema files stay
 * untouched and we hand Pi a self-contained equivalent.
 */
export function dereferenceSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = (schema.$defs ?? {}) as Record<string, unknown>;
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (node !== null && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const ref = obj.$ref;
      if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
        const key = ref.slice("#/$defs/".length);
        const target = defs[key];
        if (target === undefined) {
          throw new Error(`Unresolved local schema ref: ${ref}`);
        }
        const { $ref: _dropped, ...rest } = obj;
        return {
          ...(resolve(target) as Record<string, unknown>),
          ...(resolve(rest) as Record<string, unknown>),
        };
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "$defs") continue;
        out[k] = resolve(v);
      }
      return out;
    }
    return node;
  };
  return resolve(schema) as Record<string, unknown>;
}

let ajv: Ajv2020Type | undefined;
const validators = new Map<SchemaName, ValidateFunction>();

function getAjv(): Ajv2020Type {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
  }
  return ajv;
}

export function getValidator(name: SchemaName): ValidateFunction {
  const cached = validators.get(name);
  if (cached) return cached;
  const compiled = getAjv().compile(loadSchema(name));
  validators.set(name, compiled);
  return compiled;
}

/** Validate data against a frozen schema; returns a list of human-readable errors (empty = valid). */
export function validateAgainst(name: SchemaName, data: unknown): string[] {
  const validate = getValidator(name);
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) =>
    `${e.instancePath || "/"} ${e.message ?? "invalid"}`.trim(),
  );
}

export function assertValid<T>(name: SchemaName, data: unknown, what: string): T {
  const errors = validateAgainst(name, data);
  if (errors.length > 0) {
    throw new Error(`${what} failed ${name} schema validation: ${errors.join("; ")}`);
  }
  return data as T;
}
