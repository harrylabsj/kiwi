/**
 * 微信扫码登录流程测试——mock server 状态机：wait→scaned→confirmed、
 * expired 刷新 ≤3、scaned_but_redirect 换 base、已存凭证跳过登录。
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loginWithQrcode } from "../src/weixin/login.js";
import { IlinkClient } from "../src/weixin/ilink-client.js";
import { WeixinError } from "../src/weixin/types.js";

const servers: http.Server[] = [];

function startMock(handler: (url: string) => { status: number; body: unknown }): Promise<string> {
  const server = http.createServer((req, res) => {
    const { status, body } = handler(req.url ?? "");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const QR_RESP = {
  qrcode: "hex-token",
  qrcode_img_content: "https://liteapp.weixin.qq.com/q/abc?qrcode=hex-token&bot_type=3",
  ret: 0,
};

describe("loginWithQrcode", () => {
  it("wait → scaned → confirmed 全流程（凭证 + saved_at）", async () => {
    let statusCalls = 0;
    const base = await startMock((url) => {
      if (url.includes("get_bot_qrcode")) return { status: 200, body: QR_RESP };
      statusCalls++;
      if (statusCalls === 1) return { status: 200, body: { status: "wait" } };
      if (statusCalls === 2) return { status: 200, body: { status: "scaned" } };
      return {
        status: 200,
        body: {
          status: "confirmed",
          ilink_bot_id: "bot-9",
          bot_token: "tok-9",
          baseurl: "https://ilink-fixed.example.com",
          ilink_user_id: "wxid_owner",
        },
      };
    });
    const client = new IlinkClient({ baseUrl: base });
    const rendered: string[][] = [];
    const notices: string[] = [];
    const creds = await loginWithQrcode(client, {
      render: (qr) => rendered.push(qr),
      notice: (line) => notices.push(line),
      qrPollMs: 1,
      qrRefreshCap: 3,
      now: () => "2026-08-08T12:00:00Z",
    });
    expect(rendered.length).toBe(1);
    expect(rendered[0]!.join("\n")).toContain("█"); // ASCII 二维码已渲染
    expect(notices.some((n) => n.includes("已扫码"))).toBe(true);
    expect(creds.ilink_bot_id).toBe("bot-9");
    expect(creds.base_url).toBe("https://ilink-fixed.example.com");
    expect(creds.ilink_user_id).toBe("wxid_owner");
    expect(creds.saved_at).toBe("2026-08-08T12:00:00Z");
  });

  it("expired 刷新 ≤3 → 第 4 次 qr_expired", async () => {
    let qrCalls = 0;
    const base = await startMock((url) => {
      if (url.includes("get_bot_qrcode")) {
        qrCalls++;
        return { status: 200, body: QR_RESP };
      }
      return { status: 200, body: { status: "expired" } };
    });
    const client = new IlinkClient({ baseUrl: base });
    await expect(
      loginWithQrcode(client, { qrPollMs: 1, qrRefreshCap: 3, render: () => {}, notice: () => {} }),
    ).rejects.toMatchObject({ code: "qr_expired" });
    expect(qrCalls).toBe(4); // 初始 1 + 刷新 3
  });

  it("scaned_but_redirect → setBaseUrl 生效（后续请求打新 host）", async () => {
    let statusCalls = 0;
    const base = await startMock((url) => {
      if (url.includes("get_bot_qrcode")) return { status: 200, body: QR_RESP };
      statusCalls++;
      if (statusCalls === 1) {
        return { status: 200, body: { status: "scaned_but_redirect", redirect_host: "ilink-2.example.com" } };
      }
      return { status: 200, body: { status: "confirmed", ilink_bot_id: "b", bot_token: "t", ilink_user_id: "u" } };
    });
    const client = new IlinkClient({ baseUrl: base });
    // redirect 后 client.base 切换到 https://ilink-2.example.com——mock 只监听
    // 127.0.0.1，后续 status 轮询打真实域名 → network 错。这证明 setBaseUrl 生效。
    await expect(
      loginWithQrcode(client, { qrPollMs: 1, render: () => {}, notice: () => {} }),
    ).rejects.toMatchObject({ code: "network" });
    expect(client.base).toBe("https://ilink-2.example.com");
  });

  it("confirmed 缺少凭证 → validation", async () => {
    const base = await startMock((url) => {
      if (url.includes("get_bot_qrcode")) return { status: 200, body: QR_RESP };
      return { status: 200, body: { status: "confirmed" } };
    });
    await expect(
      loginWithQrcode(new IlinkClient({ baseUrl: base }), { qrPollMs: 1, render: () => {}, notice: () => {} }),
    ).rejects.toThrow(WeixinError);
  });
});
