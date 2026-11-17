/**
 * TOP1 M2：QuestionSpec v1（设计 §7.2 / A05 / A20）。
 * 注册表校验；旧 reason 由同一注册表渲染（文本不变）；已注册问题块只接受
 * 注册 ID 与匹配契约；每轮最多 2 个问题；模板缺失标注 renderer_fallback。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUESTION_SPEC_REGISTRY,
  QUESTION_SCHEMA_VERSION,
  QuestionSpecRegistry,
  type QuestionSpec,
} from "../src/a2a/reception/question-spec.js";
import { publishResponsePlan, InMemoryFactRegistry } from "../src/a2a/reception/publish.js";
import { sanitizeReceptionBlocks } from "../src/a2a/reception/agent-runtime.js";
import type { ReceptionBlock, ReceptionResponsePlan } from "../src/a2a/reception/types.js";

const NOW = "2026-11-17T00:00:00.000Z";

function plan(blocks: ReceptionBlock[]): ReceptionResponsePlan {
  return { locale: "zh-CN", blocks };
}

function publish(blocks: ReceptionBlock[], registry?: QuestionSpecRegistry) {
  return publishResponsePlan({
    plan: plan(blocks),
    registry: new InMemoryFactRegistry(),
    merchantId: "m-1",
    now: NOW,
    ...(registry !== undefined ? { questions: registry } : {}),
  });
}

function spec(overrides: Partial<QuestionSpec> = {}): QuestionSpec {
  return {
    question_id: "q_test_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "quantity",
    reason_code: "missing_quantity",
    description: "测试问题",
    template: "请补充数量。",
    candidate_type: "none",
    ...overrides,
  };
}

describe("QuestionSpec 注册表", () => {
  it("拒绝重复 ID、未知槽位、非法占位符与非 unit 槽位的 supported_unit 模板", () => {
    expect(() => new QuestionSpecRegistry([spec(), spec()])).toThrow(/duplicate question_id/);
    expect(() =>
      new QuestionSpecRegistry([spec({ slot: "destination" as never })]),
    ).toThrow(/slot/);
    expect(() => new QuestionSpecRegistry([spec({ template: "请提供 {free_text}" })])).toThrow(
      /placeholder/,
    );
    expect(() =>
      new QuestionSpecRegistry([
        spec({ template_with_supported_unit: "按 {supported_unit} 售卖" }),
      ]),
    ).toThrow(/only valid for the unit slot/);
  });

  it("目录只含 question_id/slot/描述，不含正文模板", () => {
    const catalog = DEFAULT_QUESTION_SPEC_REGISTRY.catalogText();
    expect(catalog).toContain("q_missing_quantity_v1 [quantity]");
    expect(catalog).not.toContain("请补充购买数量");
  });
});

describe("旧 ask_clarification 由注册表渲染（文本不变）", () => {
  const cases: Array<[Extract<ReceptionBlock, { kind: "ask_clarification" }>, string]> = [
    [
      { kind: "ask_clarification", missing: ["sku"], reason: "non_chinese" },
      "目前仅支持中文接待。请用中文说明需要的商品、数量和单位，或发送结构化 RFQ。",
    ],
    [
      { kind: "ask_clarification", missing: ["quantity"], reason: "missing_quantity" },
      "请补充购买数量（例如：2 件、1 箱）。",
    ],
    [
      {
        kind: "ask_clarification",
        missing: ["unit"],
        reason: "unit_mismatch",
        supportedUnit: "箱",
      },
      "该商品按 箱 售卖；请确认您要的单位。",
    ],
    [
      { kind: "ask_clarification", missing: ["unit"], reason: "unit_mismatch" },
      "请确认商品单位（如件/盒/箱）。",
    ],
    [
      {
        kind: "ask_clarification",
        missing: ["sku"],
        reason: "multiple_skus",
        candidates: ["SKU-1", "SKU-2"],
      },
      "一次只能咨询一个商品。您提到了：SKU-1、SKU-2。请告诉我要先确认哪一个，其余商品可以分别咨询。",
    ],
    [
      {
        kind: "ask_clarification",
        missing: ["sku"],
        reason: "product_candidates",
        candidates: ["SKU-1"],
      },
      "我在本店找到这些商品：SKU-1。请告诉我要咨询哪一个，并补充数量和单位。",
    ],
  ];

  it.each(cases)("reason=%# 渲染结果与旧文案一致且无回退标注", (block, expected) => {
    const result = publish([block]);
    expect(result.text).toBe(expected);
    expect(result.renderer_fallback).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("注册表缺少该 reason 时回退旧文案并标注 renderer_fallback", () => {
    const empty = new QuestionSpecRegistry([]);
    const result = publish(
      [{ kind: "ask_clarification", missing: ["quantity"], reason: "missing_quantity" }],
      empty,
    );
    expect(result.text).toBe("请补充购买数量（例如：2 件、1 箱）。");
    expect(result.renderer_fallback).toEqual([
      { block_kind: "ask_clarification", reason_code: "missing_quantity" },
    ]);
  });
});

describe("ask_registered_question", () => {
  it("注册 ID 按模板渲染；候选引用进入模板", () => {
    const quantity = publish([
      {
        kind: "ask_registered_question",
        question_id: "q_missing_quantity_v1",
        schema_version: QUESTION_SCHEMA_VERSION,
        slot: "quantity",
        reason_code: "missing_quantity",
      },
    ]);
    expect(quantity.text).toBe("请补充购买数量（例如：2 件、1 箱）。");

    const multiple = publish([
      {
        kind: "ask_registered_question",
        question_id: "q_multiple_skus_v1",
        schema_version: QUESTION_SCHEMA_VERSION,
        slot: "sku",
        reason_code: "multiple_skus",
        candidate_refs: ["SKU-1", "SKU-2"],
      },
    ]);
    expect(multiple.text).toContain("您提到了：SKU-1、SKU-2。");
  });

  it("未知 ID / schema / slot / reason 失配 / 非法候选一律拒绝，不回退自由问句", () => {
    const unknown = publish([
      {
        kind: "ask_registered_question",
        question_id: "q_not_registered",
        schema_version: QUESTION_SCHEMA_VERSION,
        slot: "quantity",
        reason_code: "missing_quantity",
      },
    ]);
    expect(unknown.text).toBe("");
    expect(unknown.rejected[0]?.reason).toBe("unregistered_question");

    const mismatch = publish([
      {
        kind: "ask_registered_question",
        question_id: "q_missing_quantity_v1",
        schema_version: 99,
        slot: "quantity",
        reason_code: "missing_quantity",
      },
    ]);
    expect(mismatch.rejected[0]?.reason).toBe("question_contract_mismatch");

    const wrongSlot = publish([
      {
        kind: "ask_registered_question",
        question_id: "q_missing_quantity_v1",
        schema_version: QUESTION_SCHEMA_VERSION,
        slot: "unit",
        reason_code: "missing_quantity",
      },
    ]);
    expect(wrongSlot.rejected[0]?.reason).toBe("question_contract_mismatch");

    const illegalCandidates = publish([
      {
        kind: "ask_registered_question",
        question_id: "q_missing_quantity_v1",
        schema_version: QUESTION_SCHEMA_VERSION,
        slot: "quantity",
        reason_code: "missing_quantity",
        candidate_refs: ["SKU-1"],
      },
    ]);
    expect(illegalCandidates.rejected[0]?.reason).toBe("question_contract_mismatch");
  });

  it("每轮最多 2 个问题：第 3 个拒绝并留原因", () => {
    const result = publish([
      { kind: "ask_clarification", missing: ["quantity"], reason: "missing_quantity" },
      { kind: "ask_clarification", missing: ["unit"], reason: "unit_mismatch" },
      { kind: "ask_clarification", missing: ["sku"], reason: "missing_sku" },
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("question_limit_exceeded");
  });
});

describe("sanitizeReceptionBlocks", () => {
  it("接受形状合法的已注册问题块", () => {
    const blocks = sanitizeReceptionBlocks([
      {
        kind: "ask_registered_question",
        question_id: "q_missing_quantity_v1",
        schema_version: 1,
        slot: "quantity",
        reason_code: "missing_quantity",
      },
    ]);
    expect(blocks).toEqual([
      {
        kind: "ask_registered_question",
        question_id: "q_missing_quantity_v1",
        schema_version: 1,
        slot: "quantity",
        reason_code: "missing_quantity",
      },
    ]);
  });

  it("模型只给 question_id：服务端按注册表补齐 schema/slot/reason", () => {
    const blocks = sanitizeReceptionBlocks([
      { kind: "ask_registered_question", question_id: "q_unit_mismatch_v1" },
    ]);
    expect(blocks).toEqual([
      {
        kind: "ask_registered_question",
        question_id: "q_unit_mismatch_v1",
        schema_version: 1,
        slot: "unit",
        reason_code: "unit_mismatch",
      },
    ]);
    expect(
      sanitizeReceptionBlocks([
        { kind: "ask_registered_question", question_id: "q_not_registered" },
      ]),
    ).toBeUndefined();
  });

  it("兼容模型把块类型写成 type：规范化为 kind（不扩大块种类）", () => {
    const blocks = sanitizeReceptionBlocks([
      {
        type: "show_commercial_terms",
        ref: { sku: "VQ-001", revision: "sha256:abc" },
      },
    ]);
    expect(blocks).toEqual([
      {
        kind: "show_commercial_terms",
        ref: { sku: "VQ-001", revision: "sha256:abc" },
      },
    ]);
  });

  it("拒绝非法 shape（空 ID、未知槽位、非法 schema、额外候选类型）", () => {
    expect(
      sanitizeReceptionBlocks([
        {
          kind: "ask_registered_question",
          question_id: "",
          schema_version: 1,
          slot: "quantity",
          reason_code: "missing_quantity",
        },
      ]),
    ).toBeUndefined();
    expect(
      sanitizeReceptionBlocks([
        {
          kind: "ask_registered_question",
          question_id: "q_x",
          schema_version: 1,
          slot: "destination",
          reason_code: "missing_quantity",
        },
      ]),
    ).toBeUndefined();
    expect(
      sanitizeReceptionBlocks([
        {
          kind: "ask_registered_question",
          question_id: "q_x",
          schema_version: 0,
          slot: "quantity",
          reason_code: "missing_quantity",
        },
      ]),
    ).toBeUndefined();
  });
});
