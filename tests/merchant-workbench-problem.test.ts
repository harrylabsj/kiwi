import { describe, expect, it } from "vitest";

import {
  createWorkbenchProblem,
  WORKBENCH_PROBLEM_DEFINITIONS,
} from "../src/http/merchant-management/problem.js";

describe("Workbench RFC 9457 error contract", () => {
  it("registers the 34 design codes with stable HTTP/recovery semantics", () => {
    expect(Object.keys(WORKBENCH_PROBLEM_DEFINITIONS)).toHaveLength(34);
    expect(WORKBENCH_PROBLEM_DEFINITIONS.PRECONDITION_FAILED).toMatchObject({
      status: 412,
      retryable: false,
      recoveryAction: "refresh_resource",
    });
    expect(WORKBENCH_PROBLEM_DEFINITIONS.PRECONDITION_REQUIRED).toMatchObject({ status: 428 });
    expect(WORKBENCH_PROBLEM_DEFINITIONS.DEPENDENCY_UNAVAILABLE).toMatchObject({
      status: 503,
      retryable: true,
      recoveryAction: "retry_same_operation",
    });
  });

  it("creates an RFC 9457 body from the registry rather than caller-controlled flags", () => {
    expect(
      createWorkbenchProblem("RATE_LIMITED", {
        title: "请求过多",
        detail: "请求尚未受理。",
        requestId: "req_1",
        details: { retry_after_seconds: 10 },
      }),
    ).toEqual({
      type: "urn:kiwi:problem:rate-limited",
      title: "请求过多",
      status: 429,
      detail: "请求尚未受理。",
      code: "RATE_LIMITED",
      request_id: "req_1",
      retryable: true,
      recovery_action: "retry_same_operation",
      details: { retry_after_seconds: 10 },
    });
  });

  it("unknown result requires operation_id and can never be marked retryable", () => {
    expect(() =>
      createWorkbenchProblem("OPERATION_RESULT_UNKNOWN", {
        title: "未知",
        detail: "查询原操作。",
        requestId: "req_2",
      }),
    ).toThrow(/requires operationId/);
    expect(
      createWorkbenchProblem("OPERATION_RESULT_UNKNOWN", {
        title: "未知",
        detail: "查询原操作。",
        requestId: "req_2",
        operationId: "op_2",
      }),
    ).toMatchObject({
      operation_id: "op_2",
      retryable: false,
      recovery_action: "query_operation",
    });
  });

  it("rejects sensitive detail keys and empty human-readable fields", () => {
    expect(() =>
      createWorkbenchProblem("INTERNAL_ERROR", {
        title: "内部错误",
        detail: "请联系支持。",
        requestId: "req_3",
        details: { token: "secret" },
      }),
    ).toThrow(/forbidden sensitive key/);
    expect(() =>
      createWorkbenchProblem("INTERNAL_ERROR", {
        title: " ",
        detail: "请联系支持。",
        requestId: "req_3",
      }),
    ).toThrow(/title/);
  });
});
