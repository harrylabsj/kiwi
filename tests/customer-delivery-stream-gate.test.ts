/**
 * M6-5 共用发送流门：同一 stream 只允许一条在途，UNKNOWN 不释放。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  StreamGate,
  StreamGateError,
  streamKey,
} from "../src/merchant-core/customer-delivery/stream-gate.js";

const NOW = "2026-11-18T00:00:00.000Z";
const KEY = streamKey({ merchant_id: "m-1", channel: "wechat", scope: "buyer-1" });

describe("M6-5 发送流协调门", () => {
  it("独立连接共享发送租约，过期旧持有者不能释放新租约", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-stream-"));
    const reply = StreamGate.forDataDir(dir);
    const notification = StreamGate.forDataDir(dir);
    try {
      reply.enter({ stream_key: KEY, holder_id: "reply", lease_ms: 1000, now: NOW });
      expect(() => notification.enter({
        stream_key: KEY, holder_id: "notice", lease_ms: 1000, now: NOW,
      })).toThrow(StreamGateError);
      const later = new Date(Date.parse(NOW) + 1001).toISOString();
      notification.enter({ stream_key: KEY, holder_id: "notice", lease_ms: 1000, now: later });
      reply.leave(KEY, "reply");
      expect(reply.isHeld(KEY, later)).toBe(true);
      notification.leave(KEY, "notice");
      expect(reply.isHeld(KEY, later)).toBe(false);
    } finally {
      reply.close();
      notification.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一 stream 仅一条在途；过期后可进入", () => {
    const gate = new StreamGate();
    gate.enter({ stream_key: KEY, holder_id: "reply", lease_ms: 30_000, now: NOW });
    expect(() =>
      gate.enter({ stream_key: KEY, holder_id: "notification", lease_ms: 30_000, now: NOW }),
    ).toThrow(StreamGateError);
    expect(gate.isHeld(KEY, NOW)).toBe(true);
    gate.enter({
      stream_key: KEY,
      holder_id: "notification",
      lease_ms: 30_000,
      now: "2026-11-18T00:01:00.000Z",
    });
    expect(gate.isHeld(KEY, "2026-11-18T00:01:00.000Z")).toBe(true);
  });

  it("确定结果释放；UNKNOWN 未释放前继续阻塞", () => {
    const gate = new StreamGate();
    gate.enter({ stream_key: KEY, holder_id: "reply", lease_ms: 30_000, now: NOW });
    // UNKNOWN：不调用 leave，流保持占用。
    expect(gate.isHeld(KEY, NOW)).toBe(true);
    gate.leave(KEY, "reply");
    gate.enter({ stream_key: KEY, holder_id: "notification", lease_ms: 30_000, now: NOW });
    expect(gate.isHeld(KEY, NOW)).toBe(true);
    gate.leave(KEY, "reply");
    expect(gate.isHeld(KEY, NOW)).toBe(true); // 非 holder 不能释放
    gate.leave(KEY, "notification");
    expect(gate.isHeld(KEY, NOW)).toBe(false);
  });
});
