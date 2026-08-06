/**
 * Normative Data Part examples are schema-valid（binding rc1 §8 gate 2）。
 *
 * contracts/interop/knp-data-part-examples.json 由本实现生成（scripts/
 * gen-knp-data-part-examples.mjs），shopping-cli 同组示例在自己的实现上
 * 断言 schema-valid——本测试反向防止 fixture 漂移：examples 必须继续
 * 通过本实现的 envelope 校验与 digest 验证。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  type NegotiationEnvelope,
  validateEnvelope,
  verifyEnvelopeDigest,
} from "../src/negotiation/domain/envelope.js";

const examplesPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "contracts",
  "interop",
  "knp-data-part-examples.json",
);

const examples: Array<{
  label: string;
  kind: string;
  message?: { messageId: string; parts: Array<{ kind: string; data?: { knp_envelope: object } }> };
  task?: { status: { state: string; message: { messageId: string; parts: Array<{ kind: string; data?: { knp_envelope: object } }> } } };
}> = JSON.parse(readFileSync(examplesPath, "utf8")).examples;

function envelopeOf(message: { parts: Array<{ kind: string; data?: { knp_envelope: object } }> }): NegotiationEnvelope {
  const dataPart = message.parts.find((part) => part.kind === "data");
  if (dataPart?.data === undefined) {
    throw new Error("missing data part");
  }
  return dataPart.data.knp_envelope as NegotiationEnvelope;
}

describe("Normative Data Part examples（rc1 §8 gate 2）", () => {
  it("every example envelope validates and its digest verifies", () => {
    expect(examples.length).toBeGreaterThanOrEqual(4);
    for (const example of examples) {
      const message = example.kind === "message" ? example.message : example.task?.status.message;
      if (message === undefined) {
        throw new Error(`example ${example.label} has no message`);
      }
      const envelope = envelopeOf(message);
      expect(validateEnvelope(envelope), example.label).toEqual(envelope);
      expect(verifyEnvelopeDigest(envelope), example.label).toBe(true);
    }
  });

  it("examples cover message and task kinds with a data part", () => {
    const kinds = new Set(examples.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["message", "task"]));
    for (const example of examples) {
      const message = example.kind === "message" ? example.message : example.task?.status.message;
      expect(message?.parts.some((part) => part.kind === "data"), example.label).toBe(true);
    }
  });
});
