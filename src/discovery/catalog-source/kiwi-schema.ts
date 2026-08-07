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
 * CatalogAgentRecord —— ajv 校验（fail-closed，与 candidate-agent DTO 同模式）。
 *
 * Schema canonical 来源：contracts/kiwi-catalog/1.0/agent-record.schema.json
 * （draft-07，additionalProperties: false —— 未知/私有字段在 schema 层即拒绝，
 * 完成定义 #8）。KiwiCatalogSource 对每个收到的 record 做校验；失败 →
 * CatalogSourceError("contract_violation")，绝不把未校验对象当合法候选使用。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import { CatalogSourceError } from "./errors.js";
import type { CatalogAgentRecord, ListingRecord, ListingSearchResult } from "./kiwi-record.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv") as new (opts?: { allErrors?: boolean; allowUnionTypes?: boolean }) => {
  compile(schema: Record<string, unknown>): ValidateFunction;
  addSchema(schema: Record<string, unknown>, key?: string): void;
};

/** 从本模块定位仓库根：src/discovery/catalog-source/kiwi-schema.ts → <root>。 */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

function loadSchema(name: string): Record<string, unknown> {
  const file = path.join(packageRoot(), "contracts", "kiwi-catalog", "1.0", name);
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

let compiled: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (compiled !== undefined) return compiled;
  compiled = new Ajv({ allErrors: true }).compile(loadSchema("agent-record.schema.json"));
  return compiled;
}

let listingRecordValidator: ValidateFunction | undefined;

function getListingRecordValidator(): ValidateFunction {
  if (listingRecordValidator !== undefined) return listingRecordValidator;
  // allowUnionTypes：attributes 值允许 string|number|boolean（strictTypes 仅静态检查，运行时校验仍严格）
  listingRecordValidator = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(
    loadSchema("listing-record.schema.json"),
  );
  return listingRecordValidator;
}

let listingSearchResultValidator: ValidateFunction | undefined;

function getListingSearchResultValidator(): ValidateFunction {
  if (listingSearchResultValidator !== undefined) return listingSearchResultValidator;
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const recordSchema = loadSchema("listing-record.schema.json");
  ajv.addSchema(recordSchema, "listing-record.schema.json");
  listingSearchResultValidator = ajv.compile(loadSchema("listing-search-result.schema.json"));
  return listingSearchResultValidator;
}

/**
 * 校验一个 agent record。通过则返回类型化的 CatalogAgentRecord；失败抛
 * contract_violation（fail-closed）。错误信息带 JSON Pointer 路径便于诊断。
 */
export function validateCatalogAgentRecord(value: unknown): CatalogAgentRecord {
  const validate = getValidator();
  if (validate(value)) return value as CatalogAgentRecord;
  const errors = (validate.errors ?? [])
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`.trim())
    .join("; ");
  throw new CatalogSourceError(
    "contract_violation",
    `CatalogAgentRecord failed agent-record schema validation: ${errors}`,
  );
}

/**
 * 校验一个 listing record（v0.4 §4/§5 wire 形状）。失败抛 contract_violation
 * （fail-closed）。private-only 字段（cost/floor/credentials）在 schema 层
 * additionalProperties: false 拒绝。
 */
export function validateListingRecord(value: unknown): ListingRecord {
  const validate = getListingRecordValidator();
  if (validate(value)) return value as ListingRecord;
  const errors = (validate.errors ?? [])
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`.trim())
    .join("; ");
  throw new CatalogSourceError(
    "contract_violation",
    `ListingRecord failed listing-record schema validation: ${errors}`,
  );
}

/**
 * 校验一个 listing search result（v0.4 §9 形状；CD #24：authority 恒为
 * discovery_projection、requires_direct_confirmation 恒为 true，schema 层锁定）。
 * listing 字段经 $ref 复用 listing-record.schema.json（不双份维护字段）。
 */
export function validateListingSearchResult(value: unknown): ListingSearchResult {
  const validate = getListingSearchResultValidator();
  if (validate(value)) return value as ListingSearchResult;
  const errors = (validate.errors ?? [])
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`.trim())
    .join("; ");
  throw new CatalogSourceError(
    "contract_violation",
    `ListingSearchResult failed listing-search-result schema validation: ${errors}`,
  );
}
