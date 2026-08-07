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
import type { CatalogAgentRecord } from "./kiwi-record.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv") as new (opts?: { allErrors?: boolean }) => {
  compile(schema: Record<string, unknown>): ValidateFunction;
};

/** 从本模块定位仓库根：src/discovery/catalog-source/kiwi-schema.ts → <root>。 */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

let compiled: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (compiled !== undefined) return compiled;
  const file = path.join(packageRoot(), "contracts", "kiwi-catalog", "1.0", "agent-record.schema.json");
  const schema = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  compiled = new Ajv({ allErrors: true }).compile(schema);
  return compiled;
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
