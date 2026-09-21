import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Ajv2020 as Ajv2020Type } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  createWorkbenchProblem,
  WORKBENCH_PROBLEM_DEFINITIONS,
  type WorkbenchProblemCode,
} from "../src/http/merchant-management/problem.js";
import { decimalMajorToMinor } from "../src/merchant/application/money.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as new (options?: {
  allErrors?: boolean;
  strict?: boolean;
}) => Ajv2020Type;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const problemSchema = JSON.parse(
  readFileSync(path.resolve("contracts/merchant-workbench/1.0/problem.schema.json"), "utf8"),
) as object;
const moneySchema = JSON.parse(
  readFileSync(path.resolve("contracts/merchant-workbench/1.0/money.schema.json"), "utf8"),
) as object;

describe("Merchant Workbench versioned contracts", () => {
  it("every runtime Problem definition validates against the central Schema", () => {
    const validate = ajv.compile(problemSchema);
    for (const code of Object.keys(WORKBENCH_PROBLEM_DEFINITIONS) as WorkbenchProblemCode[]) {
      const problem = createWorkbenchProblem(code, {
        title: code,
        detail: "contract vector",
        requestId: `req_${code}`,
        ...(code === "OPERATION_RESULT_UNKNOWN" ? { operationId: "op_unknown" } : {}),
      });
      expect(validate(problem), `${code}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("rejects status/retry/recovery drift instead of validating code by name only", () => {
    const validate = ajv.compile(problemSchema);
    const valid = createWorkbenchProblem("RATE_LIMITED", {
      title: "请求过多",
      detail: "稍后以同一操作重试。",
      requestId: "req_rate",
    });
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, status: 500 })).toBe(false);
    expect(validate({ ...valid, retryable: false })).toBe(false);
    expect(validate({ ...valid, recovery_action: "none" })).toBe(false);
  });

  it("validates exact Money strings and rejects legacy JSON numbers", () => {
    const validate = ajv.compile(moneySchema);
    for (const money of [
      decimalMajorToMinor("CNY", "99.99"),
      decimalMajorToMinor("JPY", "100"),
      decimalMajorToMinor("KWD", "1.234"),
    ]) {
      expect(validate(money), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(
      validate({
        currency: "CNY",
        amount_minor: 9999,
        currency_table_version: "kiwi-workbench-currency-v1-2026-09-21",
      }),
    ).toBe(false);
    expect(
      validate({
        currency: "CNY",
        amount_minor: "01",
        currency_table_version: "kiwi-workbench-currency-v1-2026-09-21",
      }),
    ).toBe(false);
  });
});
