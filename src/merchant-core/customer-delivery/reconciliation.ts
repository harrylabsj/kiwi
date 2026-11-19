import { contentDigest } from "../../negotiation/jcs.js";
import type { DeliveryRecord } from "./dispatcher.js";

export type DeliveryEvidence =
  | { outcome: "accepted"; evidence_ref: string; accepted_at: string }
  | { outcome: "not_sent"; evidence_ref: string; future_execution_blocked: true };

export function deliveryAttemptDigest(record: DeliveryRecord): string {
  return contentDigest({
    merchant_id: record.merchant_id,
    delivery_id: record.delivery_id,
    channel: record.channel,
    attempts: record.attempts ?? 0,
    started_at: record.started_at ?? null,
    payload_digest: record.payload_digest,
    provider_request_id: record.provider_request_id ?? null,
  });
}

/** Read-only lookup against the deployment's authoritative channel log gateway. */
export function createDeliveryReconciler(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): ((record: DeliveryRecord) => Promise<DeliveryEvidence | undefined>) | undefined {
  const configuredUrl = env.KIWI_DELIVERY_EVIDENCE_URL?.trim();
  if (!configuredUrl) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(configuredUrl);
  } catch {
    throw new Error("Invalid delivery evidence gateway URL");
  }
  const token = env.KIWI_DELIVERY_EVIDENCE_TOKEN?.trim();
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !token) {
    throw new Error("Delivery evidence gateway requires an HTTPS endpoint and a service token");
  }
  return async (record) => {
    if (record.started_at === undefined) return undefined;
    const url = new URL(endpoint);
    const digest = deliveryAttemptDigest(record);
    url.searchParams.set("attempt_digest", digest);
    url.searchParams.set("merchant_id", record.merchant_id);
    url.searchParams.set("delivery_id", record.delivery_id);
    url.searchParams.set("attempt", String(record.attempts ?? 0));
    url.searchParams.set("started_at", record.started_at);
    url.searchParams.set("channel", record.channel);
    if (record.provider_request_id !== undefined) {
      url.searchParams.set("provider_request_id", record.provider_request_id);
    }
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return undefined;
      const body = await response.json() as Record<string, unknown>;
      if (body?.attempt_digest !== digest || typeof body.evidence_ref !== "string" ||
          !/^[A-Za-z0-9_.:/-]{1,180}$/.test(body.evidence_ref)) return undefined;
      if (body.outcome === "not_sent" && body.future_execution_blocked === true) {
        return { outcome: "not_sent", evidence_ref: body.evidence_ref, future_execution_blocked: true };
      }
      if (body.outcome === "accepted" && typeof body.accepted_at === "string" &&
          Number.isFinite(Date.parse(body.accepted_at))) {
        return { outcome: "accepted", evidence_ref: body.evidence_ref, accepted_at: new Date(body.accepted_at).toISOString() };
      }
    } catch {
      // A transport or evidence error must not settle or resend the delivery.
    }
    return undefined;
  };
}
