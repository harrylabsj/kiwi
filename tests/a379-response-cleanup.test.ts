import { it, expect } from "vitest";
import { A2AClient } from "../src/a2a/client/client.js";
import { UcpCheckoutHttpClient } from "../src/handoff/ucp-checkout/client.js";
import { HttpCommerceClient } from "../src/commerce/http-client.js";

it.each(["a2a", "ucp", "commerce"])(
  "%s retains original cap error and bounded return when custom cancel never settles or throws",
  async (kind) => {
    for (const failure of ["pending", "throw"]) {
      let cancelled = false;
      const parent = new AbortController();
      let signal: AbortSignal | null | undefined;
      const fetchImpl: typeof fetch = async (_url, init) => {
        signal = init?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([123]));
            },
            cancel() {
              cancelled = true;
              if (failure === "throw") throw new Error("cancel must not replace cap error");
              return new Promise<void>(() => {});
            },
          }),
          { headers: { "content-length": String(9 * 1024 * 1024) } },
        );
      };
      const start = Date.now();
      if (kind === "a2a") {
        await expect(
          new A2AClient({ url: "https://fixture.invalid", skipDnsCheck: true, fetchImpl }).getTask(
            "task",
            { signal: parent.signal },
          ),
        ).rejects.toMatchObject({
          kind: "invalid_response",
          message: expect.stringMatching(/limit/),
        });
      } else if (kind === "ucp") {
        expect(
          await new UcpCheckoutHttpClient({
            endpoint: "https://fixture.invalid",
            skipDnsCheck: true,
            fetchImpl,
          }).getSession("s"),
        ).toMatchObject({
          kind: "error",
          code: "malformed",
          reason: expect.stringMatching(/large/),
        });
      } else {
        await expect(
          new HttpCommerceClient({
            baseUrl: "https://fixture.invalid",
            token: "synthetic",
            fetchImpl,
          }).getNegotiationSnapshot(
            { conversation_id: "c", message_id: 1 },
            { signal: parent.signal },
          ),
        ).rejects.toMatchObject({ kind: "transient", message: expect.stringMatching(/limit/) });
      }
      expect(Date.now() - start).toBeLessThan(300);
      expect(cancelled).toBe(true);
      expect(signal?.aborted).toBe(true);
      if (kind !== "ucp") expect(parent.signal.aborted).toBe(false);
    }
  },
);
