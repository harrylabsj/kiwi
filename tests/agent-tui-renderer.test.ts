import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TuiEventSink } from "../src/agent/host/tui-renderer.js";

function event(type: "message" | "ui" | "error", data: unknown) {
  return {
    eventId: "event-1",
    sessionId: "session-1",
    sequence: 1,
    type,
    occurredAt: "2026-09-03T00:00:00.000Z",
    data,
  } as const;
}

describe("TuiEventSink", () => {
  it("renders structured Merchant UI events and strips terminal controls", () => {
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk: Buffer) => {
      rendered += chunk.toString("utf8");
    });
    const sink = new TuiEventSink(output);
    sink.emit(event("ui", {
      component: "change_preview",
      payload: {
        headline: "危险\u001b[2J预览",
        status: "pending_approval",
        changes: [{ field: "price", before: 99, after: 89 }],
      },
    }));
    expect(rendered).toContain("[变更预览] 危险预览（pending_approval）");
    expect(rendered).toContain("price: 99 → 89");
    expect(rendered).not.toContain("\\u001b");
  });

  it("does not echo user messages and renders assistant messages/errors", () => {
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk: Buffer) => {
      rendered += chunk.toString("utf8");
    });
    const sink = new TuiEventSink(output);
    sink.emit(event("message", { role: "user", text: "secret input" }));
    sink.emit(event("message", { role: "assistant", text: "assistant reply" }));
    sink.emit(event("error", { message: "temporary failure" }));
    expect(rendered).not.toContain("secret input");
    expect(rendered).toContain("assistant reply");
    expect(rendered).toContain("[错误] temporary failure");
  });
});
