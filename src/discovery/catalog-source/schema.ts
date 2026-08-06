/**
 * CandidateAgent DTO 1.0 —— ajv 校验（fail-closed，契约 §5.1 guidance 1）。
 *
 * Schema 的 canonical 来源是 shopping-cli 仓 `CANDIDATE_AGENT_SCHEMA`（Python
 * dict），vendored 到 `contracts/candidate-agent-dto-1.0.schema.json`（draft-07，
 * 来源/同步方式见同目录 README）。Kiwi 消费该 DTO 时 MUST 对每个收到的候选
 * 元素做 schema 校验；校验失败 → CatalogSourceError("contract_violation")，
 * 绝不把未校验对象当合法候选使用。
 *
 * 实现注记：契约是 draft-07，使用 ajv 默认构建（draft-07 编译器）。仓库其他
 * frozen contract（shopping.negotiation/0.1）走 Ajv2020（2020-12），两者独立。
 * ajv 是 CommonJS，NodeNext + verbatimModuleSyntax 下用 createRequire 显式加载。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import { CatalogSourceError } from "./errors.js";
import type { CandidateAgent } from "./types.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv") as new (opts?: { allErrors?: boolean }) => {
  compile(schema: Record<string, unknown>): ValidateFunction;
};

/** 从本模块定位仓库根：src/discovery/catalog-source/schema.ts → <root>。 */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

let compiled: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (compiled !== undefined) return compiled;
  const file = path.join(packageRoot(), "contracts", "candidate-agent-dto-1.0.schema.json");
  const schema = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  compiled = new Ajv({ allErrors: true }).compile(schema);
  return compiled;
}

/**
 * 校验一个候选元素。通过则返回类型化的 CandidateAgent；失败抛
 * contract_violation（fail-closed）。错误信息带 JSON Pointer 路径便于诊断。
 */
export function validateCandidate(value: unknown): CandidateAgent {
  const validate = getValidator();
  if (validate(value)) return value as CandidateAgent;
  const errors = (validate.errors ?? [])
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`.trim())
    .join("; ");
  throw new CatalogSourceError(
    "contract_violation",
    `CandidateAgent failed DTO 1.0 schema validation: ${errors}`,
  );
}
