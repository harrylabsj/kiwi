/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * `kiwi demo`（Issue 13）：一条命令的本地多商家演示。
 *
 * 拓扑：1 Buyer + 1 **真实 kiwi-catalog 进程** + 3 Merchant（真实 A2AServer +
 * createMerchantHandler，不同价格/折扣/交期/审批规则）。
 *
 * 流程：发现 catalog → fan-out RFQ 三家 → 收集 Offer → 选最优 → CounterOffer →
 * ConditionalOffer → 求值 → Accept → non-binding Agreement → KTH HandoffCandidate
 * （三副作用恒 false，不执行）。
 *
 * 安全：无模型 API key（确定性协议演示，无 LLM）、纯本地 loopback、不真交易、
 * 隔离临时状态目录、外部写默认审批（demo 模拟审批门，不执行）、进程退出清理。
 *
 * 两个标准场景（§6.2 A/B）：低理解成本（保温杯）/ 差异化（工业批量参数化）。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { A2AServer } from "../a2a/server/index.js";
import { createMerchantHandler } from "../a2a/server/merchant-handler.js";
import { LedgerStore } from "../negotiation/ledger/index.js";
import { IdempotencyStore } from "../negotiation/idempotency/index.js";
import { A2AClient } from "../a2a/client/index.js";
import {
  finalizeEnvelope,
  type EnvelopeContent,
  type NegotiationEnvelope,
} from "../negotiation/domain/envelope.js";
import {
  newExchangeId,
  newMessageId,
  newNegotiationId,
  newOfferId,
} from "../negotiation/domain/identifiers.js";
import { contentDigest } from "../negotiation/jcs.js";
import { createHandoffCandidate, type HandoffCandidate } from "../handoff/candidate.js";
import type { A2AMessage } from "../a2a/client/index.js";

const CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";
const NOW = () => new Date().toISOString();
const DELIVERY_BEFORE = "2026-08-20T18:00:00Z";

// ---------------------------------------------------------------------------
// 场景定义（§6.2 A/B）
// ---------------------------------------------------------------------------

export interface DemoScenario {
  name: string;
  description: string;
  sku: string;
  quantity: number;
  deliveryBefore: string;
  merchants: DemoMerchantSpec[];
}

export interface DemoMerchantSpec {
  id: string;
  name: string;
  /** 商品源价（元 major）；offer = price*100 minor。 */
  price: number;
  /** 批量折扣百分比（deal price = price*(1-pct)）。 */
  dealDiscountPercent: number;
  /** 交期提示。 */
  delivery: string;
  /** 是否需要买家侧审批门（演示显示，不执行外部写）。 */
  approvalRequired: boolean;
}

const SCENARIO_A: DemoScenario = {
  name: "保温杯批量采购（低理解成本）",
  description: "一个 SKU、固定规格，聚焦价格/交期/批量折扣。",
  sku: "SKU-001",
  quantity: 200,
  deliveryBefore: DELIVERY_BEFORE,
  merchants: [
    { id: "merchant-alpha", name: "Alpha 保温杯厂", price: 880, dealDiscountPercent: 5, delivery: "2026-08-18", approvalRequired: false },
    { id: "merchant-beta", name: "Beta 生活用品", price: 850, dealDiscountPercent: 8, delivery: "2026-08-20", approvalRequired: false },
    { id: "merchant-gamma", name: "Gamma 批发行", price: 820, dealDiscountPercent: 10, delivery: "2026-08-25", approvalRequired: true },
  ],
};

const SCENARIO_B: DemoScenario = {
  name: "工业件批量采购（差异化/参数化）",
  description: "参数化规格（数量阶梯 + 交期约束），展示 ConditionalOffer 条件成交。",
  sku: "SKU-002",
  quantity: 500,
  deliveryBefore: DELIVERY_BEFORE,
  merchants: [
    { id: "merchant-delta", name: "Delta 精密件", price: 1250, dealDiscountPercent: 12, delivery: "2026-09-01", approvalRequired: false },
    { id: "merchant-epsilon", name: "Epsilon 标准件", price: 1180, dealDiscountPercent: 6, delivery: "2026-08-30", approvalRequired: false },
    { id: "merchant-zeta", name: "Zeta 总成厂", price: 1100, dealDiscountPercent: 15, delivery: "2026-09-10", approvalRequired: true },
  ],
};

export const DEMO_SCENARIOS: Record<string, DemoScenario> = { a: SCENARIO_A, b: SCENARIO_B };

// ---------------------------------------------------------------------------
// 商家 / catalog 启动
// ---------------------------------------------------------------------------

interface RunningMerchant {
  spec: DemoMerchantSpec;
  url: string;
  stop: () => void;
  dir: string;
}

interface RunningCatalog {
  url: string;
  stop: () => Promise<void>;
  dir: string;
}

async function startDemoMerchant(spec: DemoMerchantSpec, sku: string): Promise<RunningMerchant> {
  const dir = mkdtempSync(path.join(tmpdir(), `kiwi-demo-${spec.id}-`));
  const ledger = new LedgerStore({ dir });
  const idempotency = new IdempotencyStore({ dir });
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const handler = createMerchantHandler({
    ledger,
    now: NOW,
    sender: `merchant:${spec.id}`,
    counterparty: "buyer:*",
    productSource: {
      getProduct: async (requestedSku) => {
        if (requestedSku !== sku) throw new Error(`unknown sku ${requestedSku}`);
        return {
          price: spec.price, // 元 major，handler lossless 转 minor
          currency: "CNY",
          stock: 1000,
          handoff_destination: `https://${spec.id}.example/checkout/{ref}`,
        };
      },
    },
    dealDiscountPercent: spec.dealDiscountPercent,
  });
  const server = new A2AServer({
    card: () => ({
      name: spec.name,
      description: `kiwi demo merchant (${spec.id})`,
      providerOrganization: "kiwi demo",
      version: "1.0.0",
      baseUrl: holder.baseUrl,
      a2aPath: "/",
    }),
    ledger,
    idempotency,
    handler,
  });
  const http = server.createServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  holder.baseUrl = url;
  return {
    spec,
    url,
    stop: () => {
      http.closeAllConnections?.();
      http.close();
      rmSync(dir, { recursive: true, force: true });
    },
    dir,
  };
}

interface CatalogRecord {
  catalog_agent_id: string;
  principal_type: string;
  display_name: string;
  canonical_domain: string;
  agent_card_url: string;
  capabilities: string[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  return port;
}

function catalogPython(catalogDir: string): string {
  const configured = process.env.KIWI_CATALOG_PYTHON;
  if (configured !== undefined && configured !== "") return configured;
  const venvPython = path.join(catalogDir, ".venv", "bin", "python");
  return existsSync(venvPython) ? venvPython : "python3";
}

async function postCatalogJson(
  url: string,
  pathName: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok || body === null || typeof body !== "object") {
    throw new Error(`demo: kiwi-catalog ${pathName} failed (HTTP ${response.status})`);
  }
  return body as Record<string, unknown>;
}

async function waitForCatalog(url: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`demo: kiwi-catalog exited before readiness (code ${child.exitCode})`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Service is still booting; retry inside the bounded readiness window.
    }
    await delay(100);
  }
  child.kill("SIGTERM");
  throw new Error("demo: kiwi-catalog did not become ready within 15 seconds");
}

/** 启动真实 kiwi-catalog API，注册本次演示的三个商家并返回服务地址。 */
async function startDemoCatalog(records: CatalogRecord[]): Promise<RunningCatalog> {
  const configuredDir = process.env.KIWI_CATALOG_DIR;
  const catalogDir = configuredDir !== undefined && configuredDir !== ""
    ? path.resolve(configuredDir)
    : path.resolve(process.cwd(), "../kiwi-catalog");
  if (!existsSync(path.join(catalogDir, "pyproject.toml"))) {
    throw new Error(
      `demo: kiwi-catalog checkout not found at ${catalogDir}; set KIWI_CATALOG_DIR or install the sibling repository`,
    );
  }
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-demo-catalog-"));
  const db = path.join(dir, "catalog.sqlite");
  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    catalogPython(catalogDir),
    ["-m", "kiwi_catalog.scripts.kiwi_catalog_api", "--db", db, "--host", "127.0.0.1", "--port", String(port)],
    { cwd: catalogDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } },
  );
  // Drain service output so a noisy verification worker cannot fill the pipe.
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    await waitForCatalog(url, child);
    for (const record of records) {
      const registration = await postCatalogJson(url, "/v1/agents/register", {
        domain: `${record.catalog_agent_id}.local`,
        agent_card_url: record.agent_card_url,
        display_name: record.display_name,
        hosting_mode: "direct",
        capabilities: record.capabilities,
      });
      if (registration.ok !== true || registration.agent === null || typeof registration.agent !== "object") {
        throw new Error(`demo: kiwi-catalog registration failed for ${record.display_name}`);
      }
    }
    return {
      url,
      dir,
      stop: async () => {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 2_000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    if (child.exitCode === null) child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 买家 fan-out 流程
// ---------------------------------------------------------------------------

type EnvelopeSeed = Omit<EnvelopeContent, "capability" | "protocol_version" | "exchange_id" | "message_id"> &
  Partial<Pick<EnvelopeContent, "exchange_id" | "message_id">>;

function seedEnvelope(seed: EnvelopeSeed): NegotiationEnvelope {
  return finalizeEnvelope({
    capability: CAPABILITY,
    protocol_version: "1.0",
    exchange_id: seed.exchange_id ?? newExchangeId(),
    message_id: seed.message_id ?? newMessageId(),
    ...seed,
  });
}

/** 0.3 形状 message；A2AClient 在 1.0 模式由 encodeV1Part 转成 1.0 DataPart。 */
function knpMessage(envelope: NegotiationEnvelope): A2AMessage {
  return {
    role: "agent",
    messageId: envelope.message_id,
    parts: [{ kind: "data", data: { knp_envelope: envelope } }],
  };
}

function replyEnvelope(task: {
  status?: { message?: { parts?: Array<{ kind?: string; data?: Record<string, unknown> }> } };
}): NegotiationEnvelope | null {
  for (const part of task.status?.message?.parts ?? []) {
    if (part.data?.knp_envelope) return part.data.knp_envelope as NegotiationEnvelope;
  }
  return null;
}

function agreementOf(task: {
  artifacts?: Array<{ parts?: Array<{ kind?: string; data?: Record<string, unknown> }> }>;
}): Record<string, unknown> | null {
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts ?? []) {
      if (part.data?.agreement) return part.data.agreement as Record<string, unknown>;
    }
  }
  return null;
}

/** 最小 ConditionalOffer 求值：命中首条件 → then_terms；否则 base_terms。 */
function evaluateConditional(conditional: NegotiationEnvelope, quantity: number): Record<string, unknown> {
  const payload = conditional.payload as { conditions?: Array<{ when?: { all?: Array<{ field: string; op: string; value: number }> }; then_terms?: Record<string, unknown> }>; base_terms?: Record<string, unknown> };
  for (const cond of payload.conditions ?? []) {
    const matched =
      cond.when?.all?.every((c) => c.op === "gte" && quantity >= c.value) ?? false;
    if (matched && cond.then_terms) return cond.then_terms;
  }
  return payload.base_terms ?? {};
}

export interface FanoutOffer {
  merchant: DemoMerchantSpec;
  url: string;
  offer: NegotiationEnvelope;
  unitPriceMinor: number;
}

export interface DemoAgreement {
  agreement_id: string;
  negotiation_id: string;
  accepted_offer_id: string;
  terms_digest: string;
  agreed_terms: { handoff_destination?: string };
  binding_effect: string;
  creates_order: boolean;
  authorizes_payment: boolean;
  reserves_inventory: boolean;
}

export interface DemoResult {
  scenario: string;
  catalogUrl: string;
  offers: FanoutOffer[];
  chosen: FanoutOffer;
  agreement: DemoAgreement;
  handoffCandidate: HandoffCandidate;
  negotiationId: string;
}

/** fan-out RFQ：发现 → 三家询价 → 收集 Offer → 选最优 → 议价 → Agreement → Handoff。 */
export async function runFanoutBuyer(scenario: DemoScenario, catalogUrl: string): Promise<DemoResult> {
  const log = (phase: string, detail: string): void => {
    console.log(`  [${phase}] ${detail}`);
  };

  log("发现", `catalog ${catalogUrl}/v1/agents → ${scenario.merchants.length} 商家`);
  const catRes = await fetch(`${catalogUrl}/v1/agents`);
  if (!catRes.ok) throw new Error(`demo: catalog discovery failed (HTTP ${catRes.status})`);
  const cat = (await catRes.json()) as { results?: CatalogRecord[]; agents?: CatalogRecord[] };
  const records = (cat.results ?? cat.agents ?? []).filter((r) => r.principal_type === "merchant");
  log("发现", records.map((r) => r.display_name).join("、"));

  const negotiationId = newNegotiationId();
  const offers: FanoutOffer[] = [];
  for (const record of records) {
    const spec = scenario.merchants.find((m) => m.id === record.catalog_agent_id || m.name === record.display_name);
    if (spec === undefined) continue;
    log("询价", `${spec.name} RFQ ${scenario.quantity}x ${scenario.sku}`);
    const client = new A2AClient({ url: record.agent_card_url, allowPrivateRanges: true, skipDnsCheck: true });
    const rfq = seedEnvelope({
      negotiation_id: negotiationId,
      in_reply_to: "msg_start",
      actor: "buyer",
      action: "rfq",
      created_at: NOW(),
      payload: {
        type: "rfq",
        items: [{ sku: scenario.sku, quantity: { value: scenario.quantity, unit: "piece" } }],
        requested_terms: { delivery_before: scenario.deliveryBefore },
      },
    });
    const task = await client.sendMessage(knpMessage(rfq));
    const offer = replyEnvelope(task);
    if (offer === null) continue;
    const unitPriceMinor = ((offer.payload as { terms?: { items?: Array<{ unit_price?: { amount_minor: number } }> } }).terms?.items?.[0]?.unit_price?.amount_minor) ?? Number.POSITIVE_INFINITY;
    log("报价", `${spec.name} ¥${(unitPriceMinor / 100).toFixed(2)}/件`);
    offers.push({ merchant: spec, url: record.agent_card_url, offer, unitPriceMinor });
  }

  // 选最优（最低单价）。
  const chosen = [...offers].sort((a, b) => a.unitPriceMinor - b.unitPriceMinor)[0];
  if (chosen === undefined) throw new Error("demo: no merchant returned an offer");
  log("选择", `最优 ${chosen.merchant.name} ¥${(chosen.unitPriceMinor / 100).toFixed(2)}/件`);

  // CounterOffer → ConditionalOffer → 求值 → Accept。
  const client = new A2AClient({ url: chosen.url, allowPrivateRanges: true, skipDnsCheck: true });
  const counter = seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: chosen.offer.message_id,
    actor: "buyer",
    action: "counter_offer",
    created_at: NOW(),
    payload: {
      type: "counter_offer",
      offer_id: newOfferId(),
      responding_to_offer_id: (chosen.offer.payload as { offer_id: string }).offer_id,
      proposed_terms: {
        items: [
          {
            sku: scenario.sku,
            quantity: { value: scenario.quantity, unit: "piece" },
            unit_price: { currency: "CNY", amount_minor: chosen.unitPriceMinor - 500 },
          },
        ],
      },
    },
  });
  log("议价", `${chosen.merchant.name} counter_offer`);
  const condTask = await client.sendMessage(knpMessage(counter));
  const conditional = replyEnvelope(condTask);
  if (conditional === null) throw new Error("demo: no conditional offer reply");
  const agreed = evaluateConditional(conditional, scenario.quantity);
  log("议价", `条件命中 → 成交价 ¥${(((agreed as { items?: Array<{ unit_price?: { amount_minor: number } }> }).items?.[0]?.unit_price?.amount_minor ?? 0) / 100).toFixed(2)}/件`);

  const accept = seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: conditional.message_id,
    actor: "buyer",
    action: "accept_nonbinding",
    created_at: NOW(),
    payload: {
      type: "accept_nonbinding",
      offer_id: (conditional.payload as { offer_id: string }).offer_id,
      terms_digest: contentDigest(agreed),
    },
  });
  log("成交", `${chosen.merchant.name} accept_nonbinding`);
  const acceptTask = await client.sendMessage(knpMessage(accept));
  const agreement = agreementOf(acceptTask) as DemoAgreement | null;
  if (agreement === null) throw new Error("demo: no agreement artifact");

  // 审批门（外部写默认审批）：demo 模拟"审批通过"，但不执行外部写。
  if (chosen.merchant.approvalRequired) {
    log("审批", `${chosen.merchant.name} 外部写入需审批（demo 模拟审批通过，不执行）`);
  } else {
    log("审批", "无需审批（买家政策）");
  }

  // KTH HandoffCandidate（三副作用恒 false）。
  const agreedUnitPriceMinor = ((agreed as { items?: Array<{ unit_price?: { amount_minor: number } }> }).items?.[0]?.unit_price?.amount_minor) ?? 0;
  const rawDestination = String(agreement.agreed_terms?.handoff_destination ?? "").replace(
    "{ref}",
    agreement.agreement_id,
  );
  const isHttp = /^https?:\/\//.test(rawDestination);
  const handoffCandidate = createHandoffCandidate({
    agreement_id: agreement.agreement_id,
    negotiation_id: negotiationId,
    terms_digest: agreement.terms_digest,
    buyer_identity_ref: "buyer:demo",
    merchant_identity_ref: `merchant:${chosen.merchant.id}`,
    destination: {
      type: isHttp ? ("external_checkout_url" as const) : ("merchant_checkout_session" as const),
      ref: rawDestination !== "" ? rawDestination : `session:${agreement.agreement_id}`,
    },
    display_summary: {
      merchant: chosen.merchant.name,
      summary: `${scenario.quantity} units, CNY ${(agreedUnitPriceMinor / 100).toFixed(2)}/unit`,
    },
    policy_version: "handoff-policy/1",
    created_at: NOW(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    requires_user_action: chosen.merchant.approvalRequired,
  });
  log("Handoff", `候选 ${handoffCandidate.handoff_candidate_id}（${handoffCandidate.destination_type}）— 不执行`);

  return { scenario: scenario.name, catalogUrl, offers, chosen, agreement, handoffCandidate, negotiationId };
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

export interface DemoSummary {
  scenario: string;
  merchants: Array<{ id: string; url: string }>;
  result: DemoResult;
  cleaned: boolean;
}

/** 起拓扑 → 跑买家 → 清理。可注入临时目录（测试）。 */
export async function runDemo(
  scenarioKey: string = "a",
  opts: { onLog?: (phase: string, detail: string) => void } = {},
): Promise<DemoSummary> {
  const log: (phase: string, detail: string) => void =
    opts.onLog ?? ((phase: string, detail: string) => console.log(`  [${phase}] ${detail}`));
  const scenario = DEMO_SCENARIOS[scenarioKey];
  if (scenario === undefined) throw new Error(`unknown demo scenario: ${scenarioKey}`);
  log("demo", scenario.name);
  log("demo", scenario.description);

  // 1. 起 3 商家。
  const merchants = await Promise.all(scenario.merchants.map((spec) => startDemoMerchant(spec, scenario.sku)));
  const records: CatalogRecord[] = merchants.map((m) => ({
    catalog_agent_id: m.spec.id,
    principal_type: "merchant",
    display_name: m.spec.name,
    canonical_domain: `${m.spec.id}.example`,
    agent_card_url: m.url,
    capabilities: [CAPABILITY],
  }));
  // 2. 起真实 kiwi-catalog 服务并注册本次演示商家。
  const catalog = await startDemoCatalog(records);

  try {
    // 3. 买家 fan-out。
    const result = await runFanoutBuyer(scenario, catalog.url);
    return { scenario: scenario.name, merchants: merchants.map((m) => ({ id: m.spec.id, url: m.url })), result, cleaned: false };
  } finally {
    // 4. 清理（隔离目录 + 关闭 server）。
    await catalog.stop();
    for (const m of merchants) m.stop();
    log("清理", "所有 merchant / catalog 已关闭，临时目录已删除");
  }
}
