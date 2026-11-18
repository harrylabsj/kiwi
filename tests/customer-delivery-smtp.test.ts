/**
 * M6-6 SMTP adapter：本地假服务器验证 accepted 与 DATA 内容。
 */
import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createSmtpChannelAdapter } from "../src/merchant-core/customer-delivery/smtp-adapter.js";
import { prepareDelivery } from "../src/merchant-core/customer-delivery/gate.js";
import type { DeliveryRecord } from "../src/merchant-core/customer-delivery/dispatcher.js";
import { GOVERNANCE_FLAGS_DEFAULT, type GovernanceFeatureFlags } from "../src/merchant-core/context-governance/feature-flags.js";

const NOW = "2026-11-18T00:00:00.000Z";
const P1 = { ...GOVERNANCE_FLAGS_DEFAULT, customer_delivery_enabled: true } as unknown as GovernanceFeatureFlags;

function delivery(): DeliveryRecord {
  return {
    ...prepareDelivery({
      flags: P1,
      merchant_id: "m-1",
      binding: { binding_id: "b1", merchant_id: "m-1", channel: "email", address_ref: "mailref:test", verified_at: NOW, revoked_at: null, binding_epoch: 1 },
      subscription: { subscription_id: "s1", merchant_id: "m-1", binding_id: "b1", purpose: "arrival_notification", max_per_day: 1, granted_at: NOW, expires_at: "2026-11-19T00:00:00.000Z", unsubscribed_at: null, grant_epoch: 1 },
      source_grants: [],
      payload: { title: "测试主题", body: "测试正文" },
      purpose: "arrival_notification",
      seq: 1,
      valid_until: "2026-11-18T01:00:00.000Z",
      now: NOW,
      sent_today: 0,
      stream_busy: false,
      delivery_id: "dlv-1",
    }),
  };
}

describe("M6-6 SMTP", () => {
  it("STARTTLS 关闭时完成假 SMTP 会话并 accepted", async () => {
    let data = "";
    const server = createServer((socket: Socket) => {
      socket.write("220 fake ESMTP\r\n");
      let buffer = "";
      let inData = false;
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const idx = buffer.indexOf("\r\n");
          if (idx === -1) break;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 queued\r\n");
            } else {
              data += `${line}\n`;
            }
            continue;
          }
          if (line.startsWith("EHLO")) socket.write("250 fake\r\n");
          else if (line.startsWith("MAIL FROM")) socket.write("250 ok\r\n");
          else if (line.startsWith("RCPT TO")) socket.write("250 ok\r\n");
          else if (line === "DATA") { inData = true; socket.write("354 go\r\n"); }
          else if (line === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
          else socket.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const adapter = createSmtpChannelAdapter({ host: "127.0.0.1", port, starttls: false, from: "from@test", to: "to@test", timeout_ms: 5_000 });
      const result = await adapter.send({ delivery: delivery(), idempotency_key: "dlv-1", timeout_ms: 5_000 });
      expect(result.outcome).toBe("accepted");
      expect(data).toContain("Subject: 测试主题");
      expect(data).toContain("测试正文");
    } finally {
      server.close();
    }
  });
});
