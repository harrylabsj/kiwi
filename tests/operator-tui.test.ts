/**
 * TUI tests: the readline loop is driven with injected in-memory streams —
 * no TTY, no real model, FakeCommerceClient at the Commerce boundary.
 * Asserts the supervised approval boundary from the user's perspective:
 * nothing is formally submitted before /approve.
 */
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { FakeCommerceClient } from "../src/commerce/fake-client.js";
import { OperatorController } from "../src/operator/controller.js";
import { DeterministicNegotiationRunner } from "../src/operator/runner.js";
import { InMemoryOperatorEventStore } from "../src/operator/store.js";
import { createStrategyEngine } from "../src/operator/strategy.js";
import { runTui } from "../src/operator/tui.js";
import { NOW, testMarketplace, testProfile } from "./helpers.js";

function tuiSetup(): { controller: OperatorController; merchant: FakeCommerceClient } {
  const { merchant } = testMarketplace();
  const profile = testProfile();
  const controller = new OperatorController({
    profile,
    store: new InMemoryOperatorEventStore(),
    engine: createStrategyEngine(),
    runner: new DeterministicNegotiationRunner(profile, merchant),
    now: () => NOW,
  });
  return { controller, merchant };
}

function streams(lines: string[]): {
  input: Readable;
  output: Writable;
  text: () => string;
} {
  const input = Readable.from([`${lines.join("\n")}\n`]);
  let buffer = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk);
      callback();
    },
  });
  return { input, output, text: () => buffer };
}

describe("runTui", () => {
  it("shows role/agent/mode, the candidate draft, and submits only after /approve", async () => {
    const { controller, merchant } = tuiSetup();
    await controller.start();
    const { input, output, text } = streams(["/strategy", "/why", "/approve", "/usage", "/quit"]);

    const code = await runTui({ controller, input, output });
    expect(code).toBe(0);

    const out = text();
    expect(out).toContain("Kiwi Merchant · merchant-agent:merchant-001 · Supervised");
    expect(out).toContain("公开草稿");
    expect(out).toContain("等待批准");
    expect(out).toContain("Kiwi 分析");
    // Ordering: the submission notice appears only after the draft was shown
    // and /approve was processed; the marketplace got exactly one new message.
    expect(out.indexOf("公开草稿")).toBeLessThan(out.indexOf("[已发送]"));
    expect(merchant.messages()).toHaveLength(2);
    expect(merchant.claimStatus(1)).toBe("processed");
    expect(out).toContain("会话用量");
    expect(controller.getState().shutdown).toBe(true);
  });

  it("keeps the marketplace untouched for strategy talk and /quit", async () => {
    const { controller, merchant } = tuiSetup();
    await controller.start();
    const { input, output, text } = streams(["先争取包邮", "/quit"]);

    await runTui({ controller, input, output });
    const out = text();
    expect(out).toContain("策略已应用（soft_preference）");
    // A candidate was shown (supervised) but never approved: no formal write,
    // and /quit abandoned the claim instead of completing it.
    expect(out).toContain("公开草稿");
    expect(out).not.toContain("[已发送]");
    expect(merchant.messages()).toHaveLength(1);
    expect(merchant.claimStatus(1)).toBe("abandoned");
  });

  it("maps bare approve to /approve instead of a preference", async () => {
    const { controller, merchant } = tuiSetup();
    await controller.start();
    const { input, output, text } = streams(["approve", "/quit"]);

    await runTui({ controller, input, output });
    const out = text();
    expect(out).not.toContain("策略已应用");
    // The initial supervised candidate is awaiting approval; bare approve
    // submits it — never recorded as a soft_preference directive.
    expect(out).toContain("决策已提交");
    expect(merchant.messages()).toHaveLength(2);
    expect(controller.getState().strategy.directives).toHaveLength(0);
  });

  it("surfaces chat and out-of-scope tasks without applying them as strategy", async () => {
    const { controller, merchant } = tuiSetup();
    await controller.start();
    const { input, output, text } = streams(["早上好", "请帮我上架商品，价格2499元，库存3个", "/quit"]);

    await runTui({ controller, input, output });
    const out = text();
    expect(out).toContain("该消息未作为策略指令");
    expect(out).toContain("超出 Kiwi v0.2 能力范围");
    expect(out).not.toContain("策略已应用");
    expect(controller.getState().strategy.directives).toHaveLength(0);
    // Nothing was approved: the marketplace got no new formal message.
    expect(merchant.messages()).toHaveLength(1);
  });

  it("requires confirmation before switching to autopilot", async () => {
    const { controller } = tuiSetup();
    await controller.start();
    const { input, output, text } = streams(["/mode autopilot", "/quit"]);
    await runTui({ controller, input, output });
    expect(text()).toContain("需要显式确认");
    expect(controller.getState().mode).toBe("supervised");
  });

  it("/mode autopilot confirm switches and reports the change", async () => {
    const { controller, merchant } = tuiSetup();
    await controller.start();
    const { input, output, text } = streams(["/mode autopilot confirm", "/quit"]);
    await runTui({ controller, input, output });
    const out = text();
    expect(out).toContain("模式已切换为 Autopilot");
    // The initial candidate was already generated under supervised, so it
    // stays waiting for approval — no retroactive auto-submit.
    expect(merchant.messages()).toHaveLength(1);
  });

  it("shuts down safely on EOF without /quit", async () => {
    const { controller, merchant } = tuiSetup();
    await controller.start();
    const { input, output } = streams(["/usage"]);
    const code = await runTui({ controller, input, output });
    expect(code).toBe(0);
    expect(controller.getState().shutdown).toBe(true);
    // The pending candidate was abandoned, never submitted.
    expect(merchant.messages()).toHaveLength(1);
    expect(merchant.claimStatus(1)).toBe("abandoned");
  });
});
