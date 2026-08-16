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
 * Kiwi Northbound 契约 v0.1 schema 加载与校验（战略 v2.5 §5.2 / §5.3 / §5.5 / §6.2）。
 *
 * 冻结四份 Northbound 契约：
 *   - CommerceIntent           contracts/commerce-intent/1.0/schema.json
 *   - DelegationPolicy         contracts/delegation-policy/1.0/schema.json
 *   - EffectiveAuthorization   contracts/effective-authorization/1.0/schema.json
 *   - PersistentTask/Approval  contracts/persistent-task/1.0/schema.json
 *
 * 每份 JSON 文件是唯一权威源（与发布到 https://kiwi.harrylabsj.com/schemas/... 一致）。
 * 校验使用 ajv 2020 + ajv-formats（同 src/contracts/negotiation-schema.ts）。返回错误列表，
 * 空 = 合法。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Type } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

// ajv is CommonJS; under NodeNext + verbatimModuleSyntax load it explicitly
// (same pattern as src/contracts/negotiation-schema.ts).
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as new (opts?: {
  allErrors?: boolean;
  strict?: boolean;
}) => Ajv2020Type;
const addFormats = require("ajv-formats") as (ajv: Ajv2020Type) => unknown;

export type NorthboundContractName =
  | "commerce-intent"
  | "delegation-policy"
  | "effective-authorization"
  | "persistent-task";

const SCHEMA_REL: Record<NorthboundContractName, readonly string[]> = {
  "commerce-intent": ["contracts", "commerce-intent", "1.0", "schema.json"],
  "delegation-policy": ["contracts", "delegation-policy", "1.0", "schema.json"],
  "effective-authorization": ["contracts", "effective-authorization", "1.0", "schema.json"],
  "persistent-task": ["contracts", "persistent-task", "1.0", "schema.json"],
};

/** Resolve the repository/package root from this module's location. */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/contracts/northbound-schema.js -> <root>; src/... -> <root>
  return path.resolve(here, "..", "..");
}

const schemaCache = new Map<NorthboundContractName, Record<string, unknown>>();

export function loadNorthboundSchema(name: NorthboundContractName): Record<string, unknown> {
  let schema = schemaCache.get(name);
  if (schema === undefined) {
    const file = path.join(packageRoot(), ...SCHEMA_REL[name]);
    schema = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    schemaCache.set(name, schema);
  }
  return schema;
}

let ajv: Ajv2020Type | undefined;
const validatorCache = new Map<NorthboundContractName, ValidateFunction>();

function getAjv(): Ajv2020Type {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
  }
  return ajv;
}

function formatErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((e) =>
    `${e.instancePath || "/"} ${e.message ?? "invalid"}`.trim(),
  );
}

/** 校验对应 Northbound 契约是否满足冻结 schema。返回错误列表（空 = 合法）。 */
export function validateNorthboundContract(name: NorthboundContractName, value: unknown): string[] {
  let validate = validatorCache.get(name);
  if (validate === undefined) {
    validate = getAjv().compile(loadNorthboundSchema(name));
    validatorCache.set(name, validate);
  }
  if (validate(value)) return [];
  return formatErrors(validate);
}

export function validateCommerceIntent(value: unknown): string[] {
  return validateNorthboundContract("commerce-intent", value);
}

export function validateDelegationPolicy(value: unknown): string[] {
  return validateNorthboundContract("delegation-policy", value);
}

export function validateEffectiveAuthorization(value: unknown): string[] {
  return validateNorthboundContract("effective-authorization", value);
}

export function validatePersistentTask(value: unknown): string[] {
  return validateNorthboundContract("persistent-task", value);
}

/** 断言合法；非法时抛错。 */
export function assertNorthboundContractValid(
  name: NorthboundContractName,
  value: unknown,
  what: string,
): void {
  const errors = validateNorthboundContract(name, value);
  if (errors.length > 0) {
    throw new Error(`${what} failed ${name} schema validation: ${errors.join("; ")}`);
  }
}
