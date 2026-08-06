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
 * KNP/1.0 冻结 schema 加载与校验（基线 §41 #7 九类核心对象）。
 *
 * JSON 文件 contracts/negotiation/1.0/schema.json 是唯一权威源（与发布到
 * https://kiwi.harrylabsj.com/schemas/negotiation/1.0/schema.json 的内容一致）。
 * 校验使用 ajv 2020 + ajv-formats：Envelope 整体经 validateEnvelopeAgainstSchema；
 * 单个对象（如 AcceptedNonbindingAgreement artifact）经 validateNegotiationObject
 * 直接对 $defs 校验，不依赖 Envelope 包装。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Type } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

// ajv is CommonJS; under NodeNext + verbatimModuleSyntax load it explicitly
// (same pattern as src/contracts/schemas.ts).
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as new (opts?: {
  allErrors?: boolean;
  strict?: boolean;
}) => Ajv2020Type;
const addFormats = require("ajv-formats") as (ajv: Ajv2020Type) => unknown;

const SCHEMA_REL = ["contracts", "negotiation", "1.0", "schema.json"] as const;

export type NegotiationObjectName =
  | "inquiry"
  | "rfq"
  | "offer"
  | "counter_offer"
  | "conditional_offer"
  | "clarification"
  | "clarification_response"
  | "accept_nonbinding"
  | "withdraw"
  | "decline"
  | "cancel"
  | "accepted_nonbinding_agreement";

/** Resolve the repository/package root from this module's location. */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/contracts/negotiation-schema.js -> <root>; src/... -> <root>
  return path.resolve(here, "..", "..");
}

let schema: Record<string, unknown> | undefined;

export function loadNegotiationSchema(): Record<string, unknown> {
  if (schema === undefined) {
    const file = path.join(packageRoot(), ...SCHEMA_REL);
    schema = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  }
  return schema;
}

let ajv: Ajv2020Type | undefined;
const envelopeValidatorCache = new Map<string, ValidateFunction>();
const objectValidatorCache = new Map<string, ValidateFunction>();

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

/** 校验完整 Envelope 是否满足 KNP/1.0 schema（含 action↔payload 一致性）。返回错误列表（空 = 合法）。 */
export function validateEnvelopeAgainstSchema(envelope: unknown): string[] {
  let validate = envelopeValidatorCache.get("envelope");
  if (validate === undefined) {
    validate = getAjv().compile(loadNegotiationSchema());
    envelopeValidatorCache.set("envelope", validate);
  }
  if (validate(envelope)) return [];
  return formatErrors(validate);
}

/**
 * 校验单个 Negotiation Object（§9–§17 各 payload，或 AcceptedNonbindingAgreement
 * artifact）是否满足对应 $defs。返回错误列表（空 = 合法）。
 */
export function validateNegotiationObject(
  name: NegotiationObjectName,
  value: unknown,
): string[] {
  let validate = objectValidatorCache.get(name);
  if (validate === undefined) {
    const full = loadNegotiationSchema();
    // 2020-12：$ref 可与 $defs 并列，直接对单个 $def 编译。不给 $id，避免与
    // 已注册的完整 schema 发生 $id 冲突。
    const sub = {
      $ref: `#/$defs/${name}`,
      $defs: full.$defs,
    };
    validate = getAjv().compile(sub as object);
    objectValidatorCache.set(name, validate);
  }
  if (validate(value)) return [];
  return formatErrors(validate);
}

/** 断言合法；非法时抛错。 */
export function assertNegotiationEnvelopeValid(envelope: unknown, what: string): void {
  const errors = validateEnvelopeAgainstSchema(envelope);
  if (errors.length > 0) {
    throw new Error(`${what} failed KNP/1.0 schema validation: ${errors.join("; ")}`);
  }
}
