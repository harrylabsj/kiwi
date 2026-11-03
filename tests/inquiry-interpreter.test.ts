/**
 * P2 意图解析器的白名单与失败回退：
 *  - 只接受固定 intent/topics，非法 intent 整条丢弃；
 *  - 数量只在 quote_request 下保留，且必须是正整数；
 *  - 模型输出经 extractJson + 校验，异常一律 undefined。
 */
import { describe, expect, it } from "vitest";

import {
  createDeepSeekInquiryInterpreter,
  validateInquiryInterpretation,
} from "../src/a2a/server/inquiry-interpreter.js";

describe("validateInquiryInterpretation", () => {
  it("保留合法字段并过滤非法 topic", () => {
    const parsed = validateInquiryInterpretation({
      intent: "quote_request",
      topics: ["price", "warranty", "stock", "stock"],
      sku: " SKU-001 ",
      quantity: 10,
      unit: "piece",
      language: "zh",
    });
    expect(parsed).toEqual({
      intent: "quote_request",
      topics: ["price", "stock"],
      sku: "SKU-001",
      skus: ["SKU-001"],
      quantity: 10,
      unit: "piece",
      language: "zh",
    });
  });

  it("非法 intent 整条丢弃", () => {
    expect(validateInquiryInterpretation({ intent: "buy_now" })).toBeUndefined();
    expect(validateInquiryInterpretation(null)).toBeUndefined();
  });

  it("数量只在 quote_request 下保留，且排除非正整数", () => {
    expect(
      validateInquiryInterpretation({
        intent: "product_question",
        quantity: 10,
        sku: "SKU-001",
      })?.quantity,
    ).toBeUndefined();
    expect(
      validateInquiryInterpretation({
        intent: "quote_request",
        quantity: 0,
      })?.quantity,
    ).toBeUndefined();
    expect(
      validateInquiryInterpretation({
        intent: "quote_request",
        quantity: 1.5,
      })?.quantity,
    ).toBeUndefined();
  });

  it("非法 SKU 形状丢弃候选", () => {
    expect(
      validateInquiryInterpretation({ intent: "quote_request", sku: "../../etc/passwd" })?.sku,
    ).toBeUndefined();
  });
});

describe("createDeepSeekInquiryInterpreter", () => {
  it("解析 fenced JSON，且 prompt 带上买家长文本与 untrusted 约束", async () => {
    let body: Record<string, unknown> | undefined;
    const interpreter = createDeepSeekInquiryInterpreter({
      apiKey: "synthetic",
      fetchImpl: (async (_url: string, init?: { body?: unknown }) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    "```json\n{\"intent\":\"quote_request\",\"topics\":[\"stock\"],\"sku\":\"SKU-001\",\"quantity\":3,\"language\":\"en\"}\n```",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    await expect(
      interpreter.interpret({ buyer_message: "do you have 3 of SKU-001?" }),
    ).resolves.toEqual({
      intent: "quote_request",
      topics: ["stock"],
      sku: "SKU-001",
      skus: ["SKU-001"],
      quantity: 3,
      language: "en",
    });
    expect(body?.max_tokens).toBeGreaterThanOrEqual(1_000);
    expect(JSON.stringify(body)).toContain("do you have 3 of SKU-001?");
    expect(JSON.stringify(body)).toContain("untrusted data");
  });

  it("非 200 / 空正文 / 非法 JSON 都返回 undefined", async () => {
    const denied = createDeepSeekInquiryInterpreter({
      apiKey: "synthetic",
      fetchImpl: (async () => new Response("denied", { status: 403 })) as typeof fetch,
    });
    await expect(denied.interpret({ buyer_message: "x" })).resolves.toBeUndefined();

    const empty = createDeepSeekInquiryInterpreter({
      apiKey: "synthetic",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
          status: 200,
        })) as typeof fetch,
    });
    await expect(empty.interpret({ buyer_message: "x" })).resolves.toBeUndefined();

    const garbage = createDeepSeekInquiryInterpreter({
      apiKey: "synthetic",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
          status: 200,
        })) as typeof fetch,
    });
    await expect(garbage.interpret({ buyer_message: "x" })).resolves.toBeUndefined();
  });
});
