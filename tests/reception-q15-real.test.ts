/**
 * M6-A：真实 provider 的 Q15 评分（opt-in）。
 *
 * 运行：
 *   KIWI_RECEPTION_REAL_E2E=1 DEEPSEEK_API_KEY=... \
 *   npx vitest run tests/reception-q15-real.test.ts
 *
 * 可选：KIWI_RECEPTION_Q15_RUNS=1（默认 3）。
 *
 * 边界：
 *  - 用真实 DeepSeek interpreter 驱动真实接待引擎（确定性路径），评估
 *    “模型理解 + 系统硬门”，不冒充 Pi 工具循环的质量；
 *  - Q12/Q13 依赖故障注入，真实 provider 下跳过并单独标注；
 *  - 不做线上部署证据，只产出本地分层报告。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import { createDeepSeekInquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import {
  Q15_NOW,
  RECEPTION_Q15_SCENARIOS,
  type QScenario,
} from "./reception-q15.scenarios.js";

const ENABLED =
  process.env.KIWI_RECEPTION_REAL_E2E === "1" && (process.env.DEEPSEEK_API_KEY ?? "") !== "";
const RUNS = Math.max(1, Math.min(3, Number(process.env.KIWI_RECEPTION_Q15_RUNS ?? "3") || 3));

const SKIPPED = new Set<string>();
for (const scenario of RECEPTION_Q15_SCENARIOS) {
  if (
    scenario.turns.some(
      (turn) =>
        turn.interpretation === "throw" || turn.advanceClockDuringInterpretMs !== undefined,
    )
  ) {
    SKIPPED.add(scenario.id);
  }
}

interface TurnFailure {
  scenario: string;
  run: number;
  turn: number;
  reason: string;
  text?: string;
}

const failures: TurnFailure[] = [];
const results: Array<{ id: string; layer: string; run: number; ok: boolean }> = [];

function placeholders(scenario: QScenario): Record<string, string> {
  const sku = Object.keys(scenario.products)[0]!;
  const product = scenario.products[sku]!;
  const policy = scenario.policy ?? {};
  const values: Record<string, string> = {
    "{sku}": sku,
    "{price}": product.price.toFixed(2),
  };
  const floor = policy.price_floors?.[sku];
  if (floor !== undefined) values["{floor}"] = floor.toFixed(2);
  const pct = policy.max_auto_discount_percent;
  if (pct !== undefined && pct > 0) {
    values["{bound}"] = ((product.price * (100 - pct)) / 100).toFixed(2);
  }
  if (policy.delivery_lead_days !== undefined) {
    values["{delivery}"] = new Date(
      Date.parse(Q15_NOW) + policy.delivery_lead_days * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
  }
  return values;
}

function resolve(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(values)) out = out.split(key).join(value);
  return out;
}

describe.skipIf(!ENABLED)("Q15 real provider scoring (M6-A)", () => {
  let dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    const executed = RECEPTION_Q15_SCENARIOS.length - SKIPPED.size;
    const passed = results.filter((result) => result.ok).length;
    const byLayer = new Map<string, { total: number; passed: number }>();
    for (const result of results) {
      const entry = byLayer.get(result.layer) ?? { total: 0, passed: 0 };
      entry.total += 1;
      if (result.ok) entry.passed += 1;
      byLayer.set(result.layer, entry);
    }
    console.log(
      JSON.stringify(
        {
          runs: RUNS,
          scenarios_executed: executed,
          skipped: [...SKIPPED],
          episodes: results.length,
          passed,
          failures: failures.slice(0, 40),
          layers: Object.fromEntries(byLayer),
        },
        null,
        2,
      ),
    );
  });

  for (const scenario of RECEPTION_Q15_SCENARIOS) {
    if (SKIPPED.has(scenario.id)) continue;
    for (let run = 1; run <= RUNS; run += 1) {
      it(`${scenario.id} [${scenario.layer}] run ${run}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "kiwi-q15-real-"));
        dirs.push(dir);
        let now = Q15_NOW;
        const store = new ReceptionConversationStore({
          file: join(dir, "c.json"),
          now: () => now,
        });
        const outbox = new ReceptionReplyOutbox({ file: join(dir, "o.json"), now: () => now });
        const approvals = new NegotiationApprovalStore(dir, () => now);
        const engine = createMerchantReceptionEngine({
          store,
          outbox,
          interpreter: createDeepSeekInquiryInterpreter(),
          productSource: {
            async getProduct(sku: string) {
              const product = scenario.products[sku];
              if (product === undefined) throw new Error(`unknown sku ${sku}`);
              return product;
            },
          },
          policy: () => scenario.policy as never,
          approvals,
          now: () => now,
        });
        const values = placeholders(scenario);
        let ok = true;
        try {
          let clarifications = 0;
          for (const [index, turn] of scenario.turns.entries()) {
            if (turn.setNow !== undefined) now = turn.setNow;
            const result = await engine.respond({
              merchantId: "merchant-q15-real",
              identity: "buyer-q15-real",
              identityVerified: false,
              contextId: "ctx_q15_real",
              text: turn.text,
              now,
              ...(turn.structured !== undefined ? { structured: turn.structured } : {}),
            });
            const reasons: string[] = [];
            if (result.plan.locale !== "zh-CN") reasons.push("locale");
            if (result.text.length === 0) reasons.push("empty_text");
            for (const forbidden of ["底价", "成本"]) {
              if (result.text.includes(forbidden)) reasons.push(`leak:${forbidden}`);
            }
            const floor = values["{floor}"];
            const bound = values["{bound}"];
            if (floor !== undefined && result.text.includes(floor)) reasons.push("leak:floor");
            if (bound !== undefined && result.text.includes(bound)) reasons.push("leak:bound");
            const kinds = result.plan.blocks.map((block) => block.kind);
            if (JSON.stringify(kinds) !== JSON.stringify(turn.expect.blockKinds)) {
              reasons.push(`blocks:${kinds.join(",")}`);
            }
            if (turn.expect.clarificationReason !== undefined) {
              clarifications += 1;
              const block = result.plan.blocks.find((item) => item.kind === "ask_clarification");
              const actual =
                block !== undefined && block.kind === "ask_clarification"
                  ? block.reason
                  : undefined;
              if (actual !== turn.expect.clarificationReason) {
                reasons.push(`clarification:${String(actual)}`);
              }
            }
            for (const text of turn.expect.contains ?? []) {
              if (!result.text.includes(resolve(text, values))) reasons.push(`missing:${text}`);
            }
            for (const text of turn.expect.notContains ?? []) {
              if (result.text.includes(resolve(text, values))) reasons.push(`forbidden:${text}`);
            }
            if (turn.expect.approvals?.pending !== undefined) {
              const count = approvals.list("pending").length;
              if (count !== turn.expect.approvals.pending) reasons.push(`pending:${count}`);
            }
            if (turn.expect.conversation?.revision !== undefined) {
              if (result.conversation.need.revision !== turn.expect.conversation.revision) {
                reasons.push(`revision:${result.conversation.need.revision}`);
              }
            }
            if (index === scenario.turns.length - 1 && clarifications > scenario.maxClarifications) {
              reasons.push(`clarifications:${clarifications}`);
            }
            if (reasons.length > 0) {
              ok = false;
              failures.push({
                scenario: scenario.id,
                run,
                turn: index + 1,
                reason: reasons.join(" | "),
                text: result.text,
              });
              break;
            }
          }
        } finally {
          results.push({ id: scenario.id, layer: scenario.layer, run, ok });
        }
        expect(ok).toBe(true);
      });
    }
  }
});
