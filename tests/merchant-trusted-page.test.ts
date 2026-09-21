import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTrustedWorkbenchPageHandler } from "../src/http/merchant-management/trusted-page.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(createTrustedWorkbenchPageHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("trusted Workbench top-level pages", () => {
  it("registration page has strict CSP, no third-party assets and requires an enrollment code", async () => {
    const response = await fetch(`${base}/merchant/trusted/register`);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain("一次性登记码");
    expect(html).toContain("navigator.credentials.create");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("confirmation page treats request_ref only as a locator and renders snapshot with textContent", async () => {
    const response = await fetch(`${base}/merchant/trusted/confirm?ref=wcr_demo`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("request_ref 不是批准能力");
    expect(html).toContain("confirmations/by-ref/");
    expect(html).toContain("textContent=JSON.stringify(projection.snapshot");
    expect(html).toContain("navigator.credentials.get");
    expect(html).not.toContain("innerHTML");
  });
});
