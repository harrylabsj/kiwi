import { describe, expect, it } from "vitest";
import { parseWorkbenchProblem } from "../src/http/merchant-management/problem-client.js";

describe("Workbench RFC 9457 client consumer", () => {
  it("parses recovery metadata and preserves operation identity", async () => {
    const response = new Response(JSON.stringify({
      type: "urn:kiwi:problem:operation-result-unknown",
      title: "未知",
      detail: "查询原操作。",
      code: "OPERATION_RESULT_UNKNOWN",
      request_id: "req-1",
      operation_id: "op-1",
      retryable: false,
      recovery_action: "query_operation",
      details: { hint: "poll" },
    }), { status: 504, headers: { "content-type": "application/problem+json" } });
    await expect(parseWorkbenchProblem(response)).resolves.toEqual({
      type: "urn:kiwi:problem:operation-result-unknown",
      title: "未知",
      status: 504,
      detail: "查询原操作。",
      code: "OPERATION_RESULT_UNKNOWN",
      requestId: "req-1",
      operationId: "op-1",
      retryable: false,
      recoveryAction: "query_operation",
      details: { hint: "poll" },
    });
  });

  it("does not auto-retry unknown actions or malformed responses", async () => {
    const future = new Response(JSON.stringify({
      code: "FUTURE_CODE",
      detail: "未知",
      retryable: true,
      recovery_action: "retry_everything",
    }), { status: 503, headers: { "content-type": "application/problem+json" } });
    await expect(parseWorkbenchProblem(future)).resolves.toMatchObject({
      recoveryAction: "unknown",
      retryable: true,
    });
    const plain = new Response(JSON.stringify({ code: "X", detail: "Y" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await expect(parseWorkbenchProblem(plain)).resolves.toBeUndefined();
  });
});
