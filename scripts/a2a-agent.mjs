#!/usr/bin/env node
/**
 * kiwi A2A Agent — 独立 agent 启动入口（本地实测用）。
 *
 * 两个独立进程，经外部 kiwi-catalog 发现 + A2A wire 自由对话：
 *
 *   merchant（缺省自动注册进 catalog，A2AServer 对话式响应所有 KNP 动作）
 *   buyer   （经 catalog 发现 merchant → 交互式自由对话，键盘驱动）
 *
 * 用法：
 *   node scripts/a2a-agent.mjs                              # 缺省 --role buyer
 *   node scripts/a2a-agent.mjs --role merchant --port 9000
 *   node scripts/a2a-agent.mjs --role buyer --catalog http://127.0.0.1:8600
 *
 * buyer 交互命令：inquiry / rfq / counter / accept / clarify / withdraw / decline / help / quit
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { A2AServer } from "../dist/a2a/server/index.js";
import { LedgerStore } from "../dist/negotiation/ledger/index.js";
import { IdempotencyStore } from "../dist/negotiation/idempotency/index.js";
import { ContextMapStore } from "../dist/negotiation/context-map/index.js";
import { ShoppingCliCatalogSource } from "../dist/discovery/catalog-source/index.js";
import { AgentDiscovery } from "../dist/discovery/index.js";
import { selectChannelCandidate, A2ADirectChannel } from "../dist/counterparty/index.js";
import {
  newAgreementId,
  newExchangeId,
  newMessageId,
  newNegotiationId,
  newOfferId,
} from "../dist/negotiation/domain/identifiers.js";
import { finalizeEnvelope } from "../dist/negotiation/domain/envelope.js";
import { contentDigest } from "../dist/negotiation/jcs.js";
import { evaluateConditionalOffer } from "../dist/negotiation/condition/evaluator.js";

export const CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";
export const SKU = "sku-001";
export const CURRENCY = "CNY";
export const OFFER_PRICE_MINOR = 85_000;
export const DEAL_PRICE_MINOR = 83_500;
export const QUANTITY_VALUE = 200;
export const DELIVERY_BEFORE = "2026-08-20T18:00:00Z";

class Clock {
  constructor(startIso = "2026-08-07T00:00:00.000Z") {
    this.base = Date.parse(startIso);
    this.tick = 0;
  }
  now() {
    const t = new Date(this.base + this.tick);
    this.tick += 1;
    return t.toISOString();
  }
}

function seedEnvelope(seed) {
  return finalizeEnvelope({
    capability: seed.capability ?? CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: seed.negotiation_id,
    exchange_id: seed.exchange_id ?? newExchangeId(),
    message_id: seed.message_id ?? newMessageId(),
    in_reply_to: seed.in_reply_to,
    actor: seed.actor,
    action: seed.action,
    created_at: seed.created_at,
    payload: seed.payload,
    public_message: seed.public_message,
  });
}

function offerTerms(priceMinor = OFFER_PRICE_MINOR, quantity = QUANTITY_VALUE) {
  return {
    items: [
      {
        sku: SKU,
        quantity: { value: quantity, unit: "piece" },
        unit_price: { currency: CURRENCY, amount_minor: priceMinor },
      },
    ],
    fulfillment_terms: { delivery_before: DELIVERY_BEFORE },
    valid_until: "2026-08-07T00:00:00Z",
  };
}

const buildAgreement = ({ negotiation_id, accepted_offer_id, agreed_terms, created_at }) => ({
  type: "accepted_nonbinding_agreement",
  agreement_id: newAgreementId(),
  negotiation_id,
  accepted_offer_id,
  agreed_terms,
  terms_digest: contentDigest(agreed_terms),
  accepted_by: ["buyer", "merchant"],
  created_at,
  binding_effect: "nonbinding",
  creates_order: false,
  reserves_inventory: false,
  authorizes_payment: false,
});

const textReply = (text, taskState = "working") => ({
  kind: "accepted",
  taskState,
  message: { role: "agent", parts: [{ kind: "text", text }], messageId: `msg_${newMessageId()}` },
});

const envelopeReply = (reply, taskState = "working") => ({
  kind: "accepted",
  taskState,
  message: {
    role: "agent",
    parts: [{ kind: "data", data: { knp_envelope: reply } }],
    messageId: reply.message_id,
  },
});

// ---------------------------------------------------------------------------
// merchant 侧：A2AServer + 对话式 KNP handler
// ---------------------------------------------------------------------------

export function createMerchantHandler({ ledger, now, sender, counterparty }) {
  const conditionalByNegotiation = new Map();
  const appendSent = async (reply) =>
    ledger.append({
      event_kind: "message_sent",
      negotiation_id: reply.negotiation_id,
      exchange_id: reply.exchange_id,
      message_id: reply.message_id,
      in_reply_to: reply.in_reply_to,
      identity: { sender_identity: sender, counterparty_identity: counterparty, actor: reply.actor },
      capability: { capability: reply.capability, protocol_version: reply.protocol_version },
      wire_digest: reply.digest,
      wire_payload: reply,
      outcome: { kind: "ok" },
      occurred_at: reply.created_at,
    });

  return {
    handler: {
      name: "a2a-agent-merchant",
      async handle(ctx) {
        const envelope = ctx.envelope;
        const negotiationId = envelope.negotiation_id;
        const inReplyTo = envelope.message_id;

        switch (envelope.action) {
          case "inquiry": {
            // 非约束提问：文字回答。
            await appendSent(envelope);
            return textReply(
              `We carry ${SKU} at ${(OFFER_PRICE_MINOR / 100).toFixed(2)} ${CURRENCY}/piece; ask for delivery details.`,
            );
          }
          case "rfq": {
            const reply = seedEnvelope({
              negotiation_id: negotiationId,
              in_reply_to: inReplyTo,
              actor: "merchant",
              action: "offer",
              created_at: now(),
              payload: { type: "offer", offer_id: newOfferId(), terms: offerTerms(OFFER_PRICE_MINOR) },
            });
            await appendSent(reply);
            return envelopeReply(reply);
          }
          case "offer": {
            // 商家还价：对 buyer 的 offer 回 counter_offer（到 DEAL 价）。
            const reply = seedEnvelope({
              negotiation_id: negotiationId,
              in_reply_to: inReplyTo,
              actor: "merchant",
              action: "counter_offer",
              created_at: now(),
              payload: {
                type: "counter_offer",
                offer_id: newOfferId(),
                responding_to_offer_id: envelope.payload.offer_id,
                proposed_terms: offerTerms(DEAL_PRICE_MINOR),
              },
            });
            await appendSent(reply);
            return envelopeReply(reply);
          }
          case "counter_offer": {
            const quantity = envelope.payload.proposed_terms?.items?.[0]?.quantity?.value ?? QUANTITY_VALUE;
            const reply = seedEnvelope({
              negotiation_id: negotiationId,
              in_reply_to: inReplyTo,
              actor: "merchant",
              action: "conditional_offer",
              created_at: now(),
              payload: {
                type: "conditional_offer",
                offer_id: newOfferId(),
                responding_to_offer_id: envelope.payload.offer_id,
                base_terms: offerTerms(OFFER_PRICE_MINOR),
                conditions: [
                  {
                    when: { all: [{ field: "aggregate.total_quantity", op: "gte", value: 100 }] },
                    then_terms: offerTerms(DEAL_PRICE_MINOR),
                  },
                ],
              },
            });
            conditionalByNegotiation.set(negotiationId, { conditional: reply.payload, quantity });
            await appendSent(reply);
            return envelopeReply(reply);
          }
          case "clarification": {
            return textReply(
              `Regarding "${envelope.payload.questions?.[0]?.field}": delivery before ${DELIVERY_BEFORE}, payment terms negotiable (nonbinding).`,
            );
          }
          case "accept_nonbinding": {
            const stored = conditionalByNegotiation.get(negotiationId);
            const agreed_terms =
              stored === undefined
                ? offerTerms()
                : evaluateConditionalOffer(stored.conditional, { "aggregate.total_quantity": stored.quantity });
            const agreement = buildAgreement({
              negotiation_id: negotiationId,
              accepted_offer_id: envelope.payload.offer_id,
              agreed_terms,
              created_at: now(),
            });
            return {
              kind: "accepted",
              taskState: "completed",
              artifactParts: [{ kind: "data", data: { agreement } }],
              message: {
                role: "agent",
                parts: [{ kind: "text", text: "Agreement reached (nonbinding)." }],
                messageId: `msg_${newMessageId()}`,
              },
            };
          }
          case "withdraw":
            return textReply(`Withdrawn (scope=${envelope.payload.scope}).`);
          case "decline":
            return textReply(`Declined (scope=${envelope.payload.scope}).`);
          case "cancel":
            return textReply("Negotiation cancelled.");
          default:
            return { kind: "declined", reasonCode: "unsupported_action" };
        }
      },
    },
    conditionalByNegotiation,
  };
}

async function runMerchant({ port, catalog, domain }) {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-merchant-"));
  const clock = new Clock();
  const ledger = new LedgerStore({ dir, now: () => clock.now() });
  const idempotency = new IdempotencyStore({ dir, now: () => clock.now() });
  const { handler } = createMerchantHandler({
    ledger,
    now: () => clock.now(),
    sender: "merchant:a2a-demo",
    counterparty: "buyer:a2a-demo",
  });

  const holder = { baseUrl: `http://127.0.0.1:${port}` };
  const server = new A2AServer({
    card: () => ({
      name: "Kiwi A2A Demo Merchant",
      description: "Local dual-agent acceptance merchant",
      providerOrganization: "Kiwi Test Org",
      version: "1.0.0",
      baseUrl: holder.baseUrl,
      a2aPath: "/",
    }),
    ledger,
    idempotency,
    handler,
    now: () => clock.now(),
  });
  const httpServer = server.createServer();
  await new Promise((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  holder.baseUrl = `http://127.0.0.1:${port}`;

  const agentCardUrl = `${holder.baseUrl}/.well-known/agent-card.json`;
  console.log(`[merchant] A2A server ready: ${agentCardUrl}`);

  const reg = await fetch(`${catalog}/v1/agent-catalog/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain, agent_card_url: agentCardUrl, ucp_profile_url: `${holder.baseUrl}/.well-known/ucp` }),
  });
  const regBody = await reg.json().catch(() => ({}));
  console.log(
    `[merchant] registered in catalog: ${regBody.catalog_agent?.catalog_agent_id ?? "?"} (${regBody.catalog_agent?.status ?? reg.status})`,
  );

  const shutdown = async () => {
    httpServer.closeAllConnections?.();
    await new Promise((r) => httpServer.close(r));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log("[merchant] listening — Ctrl+C to stop");
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// buyer 侧：catalog 发现 + 交互式自由对话
// ---------------------------------------------------------------------------

export function buildBuyerEnvelopes(negotiationId, now, quantity) {
  const mk = (seed) => seedEnvelope({ negotiation_id: negotiationId, created_at: now(), ...seed });
  return {
    inquiry: () =>
      mk({
        actor: "buyer",
        action: "inquiry",
        payload: { type: "inquiry", subject: { sku: SKU }, questions: [{ code: "delivery.estimated_date" }] },
      }),
    rfq: () =>
      mk({
        actor: "buyer",
        action: "rfq",
        payload: {
          type: "rfq",
          items: [{ sku: SKU, quantity: { value: quantity, unit: "piece" } }],
          requested_terms: { delivery_before: DELIVERY_BEFORE },
        },
      }),
    counter: (inReplyTo, respondingToOfferId) =>
      mk({
        in_reply_to: inReplyTo,
        actor: "buyer",
        action: "counter_offer",
        payload: {
          type: "counter_offer",
          offer_id: newOfferId(),
          responding_to_offer_id: respondingToOfferId,
          proposed_terms: {
            items: [
              {
                sku: SKU,
                quantity: { value: quantity, unit: "piece" },
                unit_price: { currency: CURRENCY, amount_minor: DEAL_PRICE_MINOR },
              },
            ],
          },
        },
      }),
    accept: (inReplyTo, offerId, agreedTerms) =>
      mk({
        in_reply_to: inReplyTo,
        actor: "buyer",
        action: "accept_nonbinding",
        payload: { type: "accept_nonbinding", offer_id: offerId, terms_digest: contentDigest(agreedTerms) },
      }),
    clarify: (inReplyTo) =>
      mk({
        in_reply_to: inReplyTo,
        actor: "buyer",
        action: "clarification",
        payload: { type: "clarification", questions: [{ field: "fulfillment.delivery_before", reason: "need_eta" }] },
      }),
    withdraw: (inReplyTo, targetOfferId) =>
      mk({
        in_reply_to: inReplyTo,
        actor: "buyer",
        action: "withdraw",
        payload: {
          type: "withdraw",
          target_message_id: inReplyTo,
          ...(targetOfferId !== undefined ? { target_offer_id: targetOfferId } : {}),
          scope: targetOfferId === undefined ? "negotiation" : "offer",
        },
      }),
    decline: (inReplyTo, targetOfferId) =>
      mk({
        in_reply_to: inReplyTo,
        actor: "buyer",
        action: "decline",
        payload: {
          type: "decline",
          target_message_id: inReplyTo,
          ...(targetOfferId !== undefined ? { target_offer_id: targetOfferId } : {}),
          scope: targetOfferId === undefined ? "negotiation" : "offer",
        },
      }),
  };
}

function describeReply(task) {
  const message = task?.status?.message;
  const texts = (message?.parts ?? [])
    .filter((p) => p.kind === "text")
    .map((p) => p.text)
    .join(" ");
  const knp = message?.parts?.find((p) => p.kind === "data" && p.data?.["knp_envelope"]);
  const agreement = (task?.artifacts ?? []).flatMap((a) => a.parts).find((p) => p.kind === "data" && p.data?.["agreement"]);
  if (knp !== undefined) {
    const env = knp.data["knp_envelope"];
    const p = env.payload;
    if (env.action === "offer" || env.action === "counter_offer" || env.action === "conditional_offer") {
      const price = p.proposed_terms?.items?.[0]?.unit_price?.amount_minor ?? p.terms?.items?.[0]?.unit_price?.amount_minor;
      return { action: env.action, offer_id: p.offer_id, unit_price_minor: price, conditions: p.conditions?.length };
    }
    return { action: env.action, offer_id: p.offer_id };
  }
  if (agreement !== undefined) {
    const a = agreement.data["agreement"];
    return {
      action: "agreement",
      agreement_id: a.agreement_id,
      binding_effect: a.binding_effect,
      creates_order: a.creates_order,
      reserves_inventory: a.reserves_inventory,
      authorizes_payment: a.authorizes_payment,
    };
  }
  return { text: texts || "(no content)" };
}

async function runBuyer({ catalog, quantity }) {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-buyer-"));
  const clock = new Clock();
  const ledger = new LedgerStore({ dir, now: () => clock.now() });
  const idempotency = new IdempotencyStore({ dir, now: () => clock.now() });
  const contextMap = new ContextMapStore({ dir, now: () => clock.now() });

  const source = new ShoppingCliCatalogSource({ baseUrl: catalog });
  const discovery = new AgentDiscovery({ catalog: { source, includeBlocked: true } });
  const resolved = await discovery.resolveViaCatalog();
  if (resolved.length === 0) throw new Error("no merchant discovered via catalog — start a merchant first");
  const { candidate, profile } = resolved[0];
  console.log(`[buyer] discovered: ${candidate.catalog_agent_id} → ${candidate.discovery?.agent_card_url}`);

  const channelCandidate = selectChannelCandidate(profile);
  if (channelCandidate === null || channelCandidate.url === undefined) {
    throw new Error("no a2a-direct channel candidate");
  }

  const negotiationId = newNegotiationId();
  const channel = new A2ADirectChannel({ url: channelCandidate.url, ledger, idempotency, now: () => clock.now() });
  const handle = await channel.open({
    negotiation_id: negotiationId,
    sender_identity: "buyer:a2a-demo",
    identity: profile.identity,
  });
  const send = async (envelope) => {
    const result = await handle.send({ envelope, ref: { negotiation_id: negotiationId } });
    contextMap.set(negotiationId, { remote_context_id: result.ref.context_id, task_ids: result.ref.task_id === undefined ? [] : [result.ref.task_id] });
    return result;
  };

  const envelopes = buildBuyerEnvelopes(negotiationId, () => clock.now(), quantity);
  let lastOfferId;
  let lastInReplyTo;
  let agreedTerms;

  console.log(`[buyer] negotiating ${negotiationId} with ${profile.identity}`);
  console.log('[buyer] commands: inquiry | rfq | counter | accept | clarify | withdraw | decline | help | quit');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.setPrompt("[buyer] > ");
  // 命令串行队列：快速管道输入时逐个执行，保证 lastOfferId 等状态先后正确。
  let queue = Promise.resolve();
  let closing = false;

  const handleLine = async (line) => {
    const cmd = line.trim().toLowerCase();
    try {
      switch (cmd) {
        case "":
        case "help":
          console.log("[buyer] inquiry | rfq | counter | accept | clarify | withdraw | decline | quit");
          break;
        case "quit":
        case "exit":
          rl.close();
          return;
        case "inquiry": {
          const res = await send(envelopes.inquiry());
          console.log("[merchant]", JSON.stringify(describeReply(res.task)));
          break;
        }
        case "rfq": {
          const res = await send(envelopes.rfq());
          const reply = describeReply(res.task);
          console.log("[merchant]", JSON.stringify(reply));
          if (reply.offer_id) lastOfferId = reply.offer_id;
          lastInReplyTo = res.task?.status?.message?.messageId ?? lastInReplyTo;
          break;
        }
        case "counter": {
          if (lastOfferId === undefined) {
            console.log("[buyer] no offer yet — send rfq first");
            break;
          }
          const res = await send(envelopes.counter(lastInReplyTo ?? lastOfferId, lastOfferId));
          const reply = describeReply(res.task);
          console.log("[merchant]", JSON.stringify(reply));
          if (reply.offer_id) lastOfferId = reply.offer_id;
          lastInReplyTo = res.task?.status?.message?.messageId ?? lastInReplyTo;
          if (reply.action === "conditional_offer") {
            const knp = res.task?.status?.message?.parts?.find((p) => p.kind === "data");
            const conditional = knp?.data?.["knp_envelope"]?.payload;
            if (conditional?.type === "conditional_offer") {
              agreedTerms = evaluateConditionalOffer(conditional, { "aggregate.total_quantity": quantity });
            }
          }
          break;
        }
        case "accept": {
          if (lastOfferId === undefined) {
            console.log("[buyer] no offer to accept — send rfq/counter first");
            break;
          }
          const res = await send(envelopes.accept(lastInReplyTo ?? lastOfferId, lastOfferId, agreedTerms ?? offerTerms()));
          console.log("[merchant]", JSON.stringify(describeReply(res.task)));
          break;
        }
        case "clarify": {
          const res = await send(envelopes.clarify(lastInReplyTo));
          console.log("[merchant]", JSON.stringify(describeReply(res.task)));
          break;
        }
        case "withdraw": {
          const res = await send(envelopes.withdraw(lastInReplyTo, lastOfferId));
          console.log("[merchant]", JSON.stringify(describeReply(res.task)));
          break;
        }
        case "decline": {
          const res = await send(envelopes.decline(lastInReplyTo, lastOfferId));
          console.log("[merchant]", JSON.stringify(describeReply(res.task)));
          break;
        }
        default:
          console.log(`[buyer] unknown command "${cmd}" — try: help`);
      }
    } catch (err) {
      console.log(`[buyer] error: ${err.message}`);
    }
    if (!closing) prompt();
  };

  rl.on("line", (line) => {
    queue = queue.then(() => handleLine(line));
  });

  rl.on("close", async () => {
    closing = true;
    await queue; // 等在途命令完成后再退出
    await handle.close?.().catch(() => {});
    process.exit(0);
  });
  prompt();
}

// ---------------------------------------------------------------------------
// 入口：--role buyer|merchant（缺省 buyer）
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { role: "buyer", port: 9000, catalog: "http://127.0.0.1:8600", domain: "merchant.local", quantity: QUANTITY_VALUE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--role") args.role = argv[i + 1];
    if (argv[i] === "--port") args.port = Number(argv[i + 1]);
    if (argv[i] === "--catalog") args.catalog = argv[i + 1];
    if (argv[i] === "--domain") args.domain = argv[i + 1];
    if (argv[i] === "--quantity") args.quantity = Number(argv[i + 1]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.role === "merchant") {
    await runMerchant(args);
  } else if (args.role === "buyer") {
    await runBuyer(args);
  } else {
    throw new Error(`unknown role "${args.role}" — expected buyer or merchant`);
  }
}

main().catch((err) => {
  console.error("a2a-agent failed:", err);
  process.exit(1);
});
