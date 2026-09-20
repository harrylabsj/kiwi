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
 * M3 云端托管契约（v0.1.2）的 **JSON Schema 校验**。
 *
 * 与 `northbound-schema.ts` 同一套机制（ajv 2020 + ajv-formats，schema 文件是唯一
 * 权威源，随包发布）。四份契约：
 *
 *   - `runtime-binding-claims`     声明负载（权威副本来自交接包，逐字节并入契约锁）
 *   - `runtime-binding-document`   读响应信封（claims + claims_jws + 治理状态）
 *   - `runtime-binding-request`    创建/轮换绑定请求
 *   - `card-publication-request`   名片发布请求
 *
 * 这里提供的是**结构**校验；密码学与治理判定在 `trust/binding/verify.ts` 与
 * `discovery/catalog-source/cloud-card.ts`，两者不可互相替代。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Ajv2020 as Ajv2020Type } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

import { packageRoot } from "./northbound-schema.js";

// ajv is CommonJS; under NodeNext + verbatimModuleSyntax load it explicitly
// (same pattern as src/contracts/northbound-schema.ts).
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as new (opts?: {
  allErrors?: boolean;
  strict?: boolean;
}) => Ajv2020Type;
const addFormats = require("ajv-formats") as (ajv: Ajv2020Type) => unknown;

export type CloudContractName =
  | "runtime-binding-claims"
  | "runtime-binding-document"
  | "runtime-binding-request"
  | "card-publication-request";

export const CLOUD_CONTRACT_SCHEMA_REL: Record<CloudContractName, readonly string[]> = {
  "runtime-binding-claims": ["contracts", "runtime-binding", "0.1.2", "claims.schema.json"],
  "runtime-binding-document": ["contracts", "runtime-binding", "0.1.2", "document.schema.json"],
  "runtime-binding-request": [
    "contracts",
    "runtime-binding",
    "0.1.2",
    "binding-request.schema.json",
  ],
  "card-publication-request": ["contracts", "card-publication", "0.1.2", "request.schema.json"],
};

const schemaCache = new Map<CloudContractName, Record<string, unknown>>();

/** 读取契约 JSON（原始对象；调用方要比较内联副本时用得上）。 */
export function loadCloudContractSchema(name: CloudContractName): Record<string, unknown> {
  let schema = schemaCache.get(name);
  if (schema === undefined) {
    const file = path.join(packageRoot(), ...CLOUD_CONTRACT_SCHEMA_REL[name]);
    schema = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    schemaCache.set(name, schema);
  }
  return schema;
}

let ajv: Ajv2020Type | undefined;
const validatorCache = new Map<CloudContractName, ValidateFunction>();

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

/** 校验对应云端契约是否满足冻结 schema。返回错误列表（空 = 合法）。 */
export function validateCloudContract(name: CloudContractName, value: unknown): string[] {
  let validate = validatorCache.get(name);
  if (validate === undefined) {
    validate = getAjv().compile(loadCloudContractSchema(name));
    validatorCache.set(name, validate);
  }
  if (validate(value)) return [];
  return formatErrors(validate);
}

export function validateRuntimeBindingClaims(value: unknown): string[] {
  return validateCloudContract("runtime-binding-claims", value);
}

export function validateRuntimeBindingDocument(value: unknown): string[] {
  return validateCloudContract("runtime-binding-document", value);
}
