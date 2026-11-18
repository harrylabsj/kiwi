/**
 * M6-5：接待回复 outbox 与经营通知共用 StreamGate；unknown 保持占用。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import {
  StreamGate,
  StreamGateError,
} from "../src/merchant-core/customer-delivery/stream-gate.js";

const NOW = "2026-11-18T00:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function outbox() {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-reply-gate-"));
  dirs.push(dir);
  const gate = new StreamGate();
  const box = new ReceptionReplyOutbox({
    file: join(dir, "reply-outbox.json"),
    now: () => NOW,
    gate,
  });
  return { gate, box };
}

function record(responseId: string, status: "dispatched" | "unknown") {
  return {
    response_id: responseId,
    merchantId: "m-1",
    identity: "buyer-1",
    contextId: "ctx-1",
    reply_seq: status === "unknown" ? 1 : 2,
    text_digest: "sha256:text",
    dispatch_class: "automatic" as const,
    status,
  };
}

describe("接待回复 outbox 流门", () => {
  it("unknown 占用同一 stream；对账完成后释放", () => {
    const { gate, box } = outbox();
    box.record(record("resp-1", "unknown"));
    const key = "m-1:a2a:buyer-1:ctx-1";
    expect(gate.isHeld(key, NOW)).toBe(true);
    expect(() => box.record(record("resp-2", "unknown"))).toThrow(StreamGateError);
    expect(box.markStatus("resp-1", "dispatched")).toBe(true);
    expect(gate.isHeld(key, NOW)).toBe(false);
    expect(() => box.record(record("resp-2", "unknown"))).not.toThrow();
  });

  it("dispatched 不占用流", () => {
    const { gate, box } = outbox();
    box.record(record("resp-1", "dispatched"));
    expect(gate.isHeld("m-1:a2a:buyer-1:ctx-1", NOW)).toBe(false);
  });

  it("P2-4：dispatched 转 unknown 时占用；重启后持久 unknown 重新占用", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-reply-gate-"));
    dirs.push(dir);
    const file = join(dir, "reply-outbox.json");
    const gate = new StreamGate();
    const box = new ReceptionReplyOutbox({ file, now: () => NOW, gate });
    box.record(record("resp-1", "dispatched"));
    const key = "m-1:a2a:buyer-1:ctx-1";
    expect(gate.isHeld(key, NOW)).toBe(false);
    box.markStatus("resp-1", "unknown");
    expect(gate.isHeld(key, NOW)).toBe(true);

    const restartedGate = new StreamGate();
    new ReceptionReplyOutbox({ file, now: () => NOW, gate: restartedGate });
    expect(restartedGate.isHeld(key, NOW)).toBe(true);
  });
});
