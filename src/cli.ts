#!/usr/bin/env node
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
 * kiwi — standalone commerce negotiation agent runtime.
 *
 * Commands:
 *   kiwi doctor --profile <file>            Read-only diagnostics.
 *   kiwi agent run --profile <file> --once  Process at most one claimed message.
 *   kiwi agent run --profile <file>         Foreground serial polling until
 *                                           SIGINT/SIGTERM (exit 0).
 *   kiwi tui --profile <file>               Interactive operator TUI
 *                                           (supervised by default).
 *   kiwi init|up|status|logs|down --dir <instance-dir>
 *                                           Managed-local product lifecycle.
 */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDataDir, ensurePathsForDir } from "./agent/agent-db.js";
import { startA2aNode, type A2aNodeHandle } from "./a2a/node.js";
import type { ChatA2aNode } from "./agent/chat-tui.js";
import { runChatTui } from "./agent/chat-tui.js";
import { createFakeChatModels } from "./agent/fake-chat-model.js";
import { isAgentMode, type AgentMode } from "./agent/mode.js";
import { AgentKernel, type AgentKernelOptions } from "./agent/kernel.js";
import { loadProfile, ProfileError, resolveSecret, RUNTIME_VERSION, type AgentProfile } from "./config/profile.js";
import { HttpCommerceClient } from "./commerce/http-client.js";
import type { CommerceClient } from "./commerce/types.js";
import { CommerceError } from "./commerce/types.js";
import { runDoctor } from "./doctor.js";
import { EXIT } from "./exit-codes.js";
import { createDeterministicStreamFn } from "./runtime/fake-model.js";
import { runForeground } from "./runtime/foreground.js";
import { runNegotiationTurn, type TurnReport } from "./runtime/negotiation-turn.js";
import { isFakeProvider, realStreamFn, resolveThinkingLevel } from "./runtime/model.js";
import { OperatorController } from "./operator/controller.js";
import { DeterministicNegotiationRunner } from "./operator/runner.js";
import { FileOperatorEventStore, OperatorStoreError } from "./operator/store.js";
import { createStrategyEngine } from "./operator/strategy.js";
import { runTui } from "./operator/tui.js";
import { runInit } from "./supervisor/init.js";
import { runDown, runStatus, runUp, SupervisorError } from "./supervisor/manage.js";
import { parseLogLines, runLogs } from "./supervisor/logs.js";
import { StackConfigError } from "./supervisor/stack-config.js";
import { cmdProductDoctor, productHelp, PRODUCT_VERSION } from "./product-cli.js";
import { merchantInit } from "./product-init.js";
import { buyerInit, buyerSearch, buyerTasks } from "./product-buyer.js";
import { merchantPublish } from "./product-publish.js";

const USAGE = `kiwi ${PRODUCT_VERSION} — commerce negotiation agent runtime

Usage:
  kiwi init --dir <dir> [--shopping-cli-src <path>] [--fake]
                                          Create a managed-local instance
  kiwi up --dir <dir>                     Start gateway + enabled agents (idempotent)
  kiwi status --dir <dir>                 Structured JSON instance status
  kiwi logs --dir <dir> [--lines N]       Redacted, labeled tail of instance logs
  kiwi down --dir <dir>                   Verified shutdown of this instance only
  kiwi doctor --profile <file>            Read-only diagnostics (no writes)
  kiwi agent run --profile <file> --once  Run one negotiation turn, then exit
  kiwi agent run --profile <file>         Foreground serial polling (SIGINT/SIGTERM to stop)
  kiwi agent serve --profile <file> [--catalog <url>] [--port N] [--no-chat]
                                          Run a merchant A2A server + register in kiwi-catalog
                                          (default: also opens the kiwi> conversation)
  kiwi tui --profile <file> [--data-dir <dir>]
                                          Interactive operator TUI (supervised by default;
                                          approves candidates before any formal submit)
  kiwi [--no-a2a]                         Conversation TUI + auto A2A node (merchant
                                          registers in kiwi-catalog); /profile /a2a
                                          /discover /negotiate /register in-session
  kiwi chat --profile <file> [--data-dir <dir>]
                                          Main conversation with Principal Memory (v0.3.0-A)

Product layer (product-strategy rev1.1 §10/§19):
  kiwi buyer --help                       Kiwi Buyer command tree
  kiwi merchant --help                    Kiwi Merchant command tree
  kiwi network --help                     Kiwi Network command tree
  kiwi doctor                             Aggregate health: kiwi runtime +
                                          shopping-cli presence + kiwi-catalog
                                          reachability (no --profile needed)

  kiwi --version                          Print version
  kiwi --help                             This help

Profiles select the role (buyer or merchant); both share the same runtime.
Turn reports are printed as JSONL (one JSON object per line) and never
contain secrets or private policy values. Secrets come from environment
variables named in the profile (commerce.token_env, model.api_key_env);
they are never read from or written to the profile file.
`;

interface ParsedArgs {
  command: string[];
  profile?: string;
  dir?: string;
  lines?: string;
  shoppingCliSrc?: string;
  shoppingCliDb?: string;
  shoppingCliPath?: string;
  shoppingCliMerchant?: string;
  merchantId?: string;
  merchantName?: string;
  output?: string;
  force: boolean;
  noInstall: boolean;
  agentId?: string;
  ownerId?: string;
  autoNegotiate: boolean;
  limit?: string;
  category?: string;
  region?: string;
  listingType?: string;
  dataDir?: string;
  once: boolean;
  fake: boolean;
  catalog?: string;
  port?: number;
  noChat: boolean;
  noA2a: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  let profile: string | undefined;
  let dir: string | undefined;
  let lines: string | undefined;
  let shoppingCliSrc: string | undefined;
  let shoppingCliDb: string | undefined;
  let shoppingCliPath: string | undefined;
  let shoppingCliMerchant: string | undefined;
  let merchantId: string | undefined;
  let merchantName: string | undefined;
  let output: string | undefined;
  let force = false;
  let noInstall = false;
  let agentId: string | undefined;
  let ownerId: string | undefined;
  let autoNegotiate = false;
  let limit: string | undefined;
  let category: string | undefined;
  let region: string | undefined;
  let listingType: string | undefined;
  let dataDir: string | undefined;
  let catalog: string | undefined;
  let port: number | undefined;
  let once = false;
  let fake = false;
  let noChat = false;
  let noA2a = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") {
      profile = argv[++i];
    } else if (arg === "--dir") {
      dir = argv[++i];
    } else if (arg === "--lines") {
      lines = argv[++i];
    } else if (arg === "--shopping-cli-src") {
      shoppingCliSrc = argv[++i];
    } else if (arg === "--shopping-cli-db") {
      shoppingCliDb = argv[++i];
    } else if (arg === "--shopping-cli-path") {
      shoppingCliPath = argv[++i];
    } else if (arg === "--shopping-cli-merchant") {
      shoppingCliMerchant = argv[++i];
    } else if (arg === "--merchant-id") {
      merchantId = argv[++i];
    } else if (arg === "--name") {
      merchantName = argv[++i];
    } else if (arg === "--output") {
      output = argv[++i];
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--no-install") {
      noInstall = true;
    } else if (arg === "--agent-id") {
      agentId = argv[++i];
    } else if (arg === "--owner-id") {
      ownerId = argv[++i];
    } else if (arg === "--auto-negotiate") {
      autoNegotiate = true;
    } else if (arg === "--limit") {
      limit = argv[++i];
    } else if (arg === "--category") {
      category = argv[++i];
    } else if (arg === "--region") {
      region = argv[++i];
    } else if (arg === "--listing-type") {
      listingType = argv[++i];
    } else if (arg === "--data-dir") {
      dataDir = argv[++i];
    } else if (arg === "--catalog") {
      catalog = argv[++i];
    } else if (arg === "--port") {
      port = Number(argv[++i]);
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--fake") {
      fake = true;
    } else if (arg === "--no-chat") {
      noChat = true;
    } else if (arg === "--no-a2a") {
      noA2a = true;
    } else if (arg !== undefined && arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else if (arg !== undefined && arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg !== undefined && arg.startsWith("--lines=")) {
      lines = arg.slice("--lines=".length);
    } else if (arg !== undefined && arg.startsWith("--shopping-cli-src=")) {
      shoppingCliSrc = arg.slice("--shopping-cli-src=".length);
    } else if (arg !== undefined && arg.startsWith("--merchant-id=")) {
      merchantId = arg.slice("--merchant-id=".length);
    } else if (arg !== undefined && arg.startsWith("--name=")) {
      merchantName = arg.slice("--name=".length);
    } else if (arg !== undefined && arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else if (arg !== undefined && !arg.startsWith("-")) {
      command.push(arg);
    } else {
      throw new ProfileError(`Unknown argument: ${arg ?? ""}`);
    }
  }
  const out: ParsedArgs = { command, once, fake, noChat, noA2a, force, noInstall, autoNegotiate };
  if (profile !== undefined) out.profile = profile;
  if (dir !== undefined) out.dir = dir;
  if (lines !== undefined) out.lines = lines;
  if (shoppingCliSrc !== undefined) out.shoppingCliSrc = shoppingCliSrc;
  if (shoppingCliDb !== undefined) out.shoppingCliDb = shoppingCliDb;
  if (shoppingCliPath !== undefined) out.shoppingCliPath = shoppingCliPath;
  if (shoppingCliMerchant !== undefined) out.shoppingCliMerchant = shoppingCliMerchant;
  if (merchantId !== undefined) out.merchantId = merchantId;
  if (merchantName !== undefined) out.merchantName = merchantName;
  if (output !== undefined) out.output = output;
  if (agentId !== undefined) out.agentId = agentId;
  if (ownerId !== undefined) out.ownerId = ownerId;
  if (limit !== undefined) out.limit = limit;
  if (category !== undefined) out.category = category;
  if (region !== undefined) out.region = region;
  if (listingType !== undefined) out.listingType = listingType;
  if (dataDir !== undefined) out.dataDir = dataDir;
  if (catalog !== undefined) out.catalog = catalog;
  if (port !== undefined) out.port = port;
  return out;
}

function requireDir(args: ParsedArgs): string {
  if (!args.dir) {
    throw new ProfileError("--dir <instance-dir> is required");
  }
  return args.dir;
}

function requireProfile(args: ParsedArgs): AgentProfile {
  if (!args.profile) {
    throw new ProfileError("--profile <file> is required");
  }
  return loadProfile(args.profile);
}

function buildClient(profile: AgentProfile): CommerceClient {
  const token = resolveSecret(profile.commerce.token_env, "commerce token");
  return new HttpCommerceClient({
    baseUrl: profile.commerce.base_url,
    token,
  });
}

function printReportJsonl(report: TurnReport): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

// A closed stdout (e.g. `kiwi ... | head -1`) must not crash the CLI.
process.stdout.on("error", (err: { code?: string }) => {
  if (err.code !== "EPIPE") throw err;
});
function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function cmdDoctor(args: ParsedArgs): Promise<number> {
  const profile = requireProfile(args);
  let client: CommerceClient | undefined;
  try {
    client = buildClient(profile);
  } catch {
    // doctor reports the missing env var as a failed check instead of dying
    client = undefined;
  }
  const report = await runDoctor(args.profile as string, client);
  printJson(report);
  if (report.ok) return EXIT.OK;
  const authFailed = report.checks.some(
    (c) => !c.ok && (c.name === "commerce_token_env" || c.detail.startsWith("auth:")),
  );
  return authFailed ? EXIT.AUTH : EXIT.CONFIG;
}

function commerceErrorExit(err: CommerceError): number {
  process.stderr.write(`commerce error (${err.kind}): ${err.message}\n`);
  return err.kind === "auth" ? EXIT.AUTH : err.kind === "transient" ? EXIT.TRANSIENT : EXIT.CONFIG;
}

function outcomeExit(report: TurnReport): number {
  switch (report.outcome.kind) {
    case "accepted":
    case "no_work":
    case "already_claimed":
      return EXIT.OK;
    case "human_required":
      return EXIT.HUMAN;
    case "no_decision":
    case "timeout":
    case "aborted":
      return EXIT.TRANSIENT;
    case "failed":
      return report.outcome.retriable ? EXIT.TRANSIENT : EXIT.MODEL;
  }
}

async function cmdAgentRun(args: ParsedArgs): Promise<number> {
  const profile = requireProfile(args);

  let client: CommerceClient;
  try {
    client = buildClient(profile);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.CONFIG;
  }

  const fake = isFakeProvider(profile);
  const streamFn = fake ? createDeterministicStreamFn(profile) : realStreamFn();
  const getApiKey = fake
    ? undefined
    : (): string | undefined => {
        const envName = profile.model.api_key_env;
        if (!envName) return undefined;
        return process.env[envName];
      };

  if (args.once) {
    // Same shutdown semantics as the foreground loop: SIGINT/SIGTERM aborts
    // the in-flight turn, which abandons an unsettled claim (never
    // completes it) instead of orphaning it until the stale-claim TTL.
    const shutdown = new AbortController();
    const onSignal = (): void => shutdown.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    let report: TurnReport;
    try {
      report = await runNegotiationTurn({
        profile,
        client,
        streamFn,
        ...(getApiKey !== undefined ? { getApiKey } : {}),
        signal: shutdown.signal,
      });
    } catch (err) {
      if (err instanceof CommerceError) return commerceErrorExit(err);
      process.stderr.write(
        `unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return EXIT.TRANSIENT;
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    printReportJsonl(report);
    return outcomeExit(report);
  }

  // Foreground serial polling. SIGINT/SIGTERM abort the in-flight turn
  // (unsettled claims are abandoned, never completed) and stop the loop
  // cleanly with exit 0.
  const shutdown = new AbortController();
  const onSignal = (): void => shutdown.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await runForeground({
      profile,
      client,
      streamFn,
      ...(getApiKey !== undefined ? { getApiKey } : {}),
      signal: shutdown.signal,
      onReport: printReportJsonl,
    });
    return EXIT.OK;
  } catch (err) {
    if (err instanceof CommerceError) return commerceErrorExit(err);
    process.stderr.write(`unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.TRANSIENT;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

/**
 * Interactive operator TUI (v0.2). Candidate generation uses the
 * deterministic runner wired to the real CommerceClient boundary — formal
 * writes still go through CommerceClient and the gateway policy gate. The
 * embedded-Pi candidate backend is the documented next integration hook.
 */
async function cmdTui(args: ParsedArgs): Promise<number> {
  const profile = requireProfile(args);

  let client: CommerceClient;
  try {
    client = buildClient(profile);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.CONFIG;
  }

  const dataDir = args.dataDir ?? path.resolve(".kiwi", "agents", profile.agent_id);
  const controller = new OperatorController({
    profile,
    store: new FileOperatorEventStore(dataDir),
    engine: createStrategyEngine(),
    runner: new DeterministicNegotiationRunner(profile, client),
  });
  try {
    await controller.start();
    return await runTui({ controller, input: process.stdin, output: process.stdout });
  } catch (err) {
    if (err instanceof CommerceError) return commerceErrorExit(err);
    if (err instanceof OperatorStoreError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.CONFIG;
    }
    process.stderr.write(`unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.TRANSIENT;
  }
}

/**
 * `kiwi agent serve`：把 merchant profile 变成可被 catalog 发现的 A2A merchant。
 *
 * 从 merchant profile 构建身份 + Agent Card，起 A2AServer（生产 KNP merchant
 * handler），启动时注册进 kiwi-catalog，buyer 可经 catalog 发现并磋商。
 *
 *   kiwi agent serve --profile <merchant.yaml> [--catalog http://127.0.0.1:8600]
 *                    [--port 9000] [--data-dir <dir>]
 */
async function cmdAgentServe(args: ParsedArgs): Promise<number> {
  const profile = requireProfile(args);
  if (profile.role !== "merchant") {
    process.stderr.write("kiwi agent serve 需要 merchant profile（role: merchant）\n");
    return EXIT.CONFIG;
  }
  const catalog = args.catalog ?? process.env.KIWI_CATALOG_URL ?? "http://127.0.0.1:8600";
  let node: A2aNodeHandle | null = await startA2aNode({
    profile,
    catalog,
    preferredPort: args.port,
    ownerTokenSecret: process.env.KIWI_CATALOG_OWNER_TOKEN_SECRET,
  });
  console.log(`[agent serve] merchant ${profile.agent_id} A2A server: ${node.agentCardUrl}`);
  console.log(`[agent serve] registered in catalog ${catalog}: ${node.catalogAgentId ?? "?"}`);

  const a2aNode: ChatA2aNode = {
    status: () =>
      node === null
        ? null
        : {
            role: node.role,
            url: node.url,
            agentCardUrl: node.agentCardUrl,
            ...(node.catalogAgentId !== undefined ? { catalogAgentId: node.catalogAgentId } : {}),
          },
    rebuild: async (p) => {
      await node?.stop().catch(() => undefined);
      node = await startA2aNode({
        profile: p as AgentProfile,
        catalog,
        preferredPort: args.port,
        ownerTokenSecret: process.env.KIWI_CATALOG_OWNER_TOKEN_SECRET,
      });
    },
    stop: async () => {
      await node?.stop().catch(() => undefined);
      node = null;
    },
  };

  // --no-chat 或非交互 stdin（后台/重定向）：仅 A2A server 常驻，不进入对话。
  if (args.noChat === true || process.stdin.isTTY !== true) {
    const shutdown = async (): Promise<void> => {
      await a2aNode.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log(
      args.noChat === true
        ? "[agent serve] listening（--no-chat）— Ctrl+C to stop"
        : "[agent serve] listening（非交互 stdin，仅 A2A server）— Ctrl+C to stop",
    );
    await new Promise<never>(() => {});
    return EXIT.OK;
  }

  // 内置对话（缺省）：同一进程既是 A2A 节点又能 `kiwi>` 对话。/quit 退出整个进程。
  const kernel = await buildChatKernel(profile, args.dataDir, catalog);
  const kernels: AgentKernel[] = [kernel];
  const reload = async (file: string): Promise<AgentKernel> => {
    const next = await buildChatKernel(loadProfile(resolveProfilePath(file)), args.dataDir, catalog);
    kernels.push(next);
    return next;
  };
  const shutdown = async (): Promise<void> => {
    await a2aNode.stop();
    for (const k of kernels) await k.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log("[agent serve] A2A server + 内置对话（/quit 退出整个进程）");
  try {
    return await runChatTui({ kernel, input: process.stdin, output: process.stdout, reload, a2aNode, catalog });
  } finally {
    await a2aNode.stop();
    for (const k of kernels) await k.close().catch(() => undefined);
  }
}

/**
 * 裸 `kiwi` 的默认聊天 profile：底层大模型**可配置**（从环境变量读取，不 hardcode）。
 * - KIWI_MODEL_PROVIDER（默认 deepseek）
 * - KIWI_MODEL（默认 deepseek-v4-flash）
 * - KIWI_MODEL_API_KEY_ENV（默认 DEEPSEEK_API_KEY）
 * - KIWI_MODEL_BASE_URL（可选覆盖）
 */
function defaultChatProfile(): AgentProfile {
  const provider = process.env.KIWI_MODEL_PROVIDER ?? "deepseek";
  const model = process.env.KIWI_MODEL ?? "deepseek-v4-flash";
  const apiKeyEnv = process.env.KIWI_MODEL_API_KEY_ENV ?? "DEEPSEEK_API_KEY";
  const baseUrl = process.env.KIWI_MODEL_BASE_URL;
  return {
    runtime_version: RUNTIME_VERSION,
    protocol_version: "shopping.negotiation/0.1",
    agent_id: "kiwi-assistant",
    role: "buyer",
    owner_id: "kiwi-user",
    commerce: {
      base_url: "http://127.0.0.1:8765",
      token_env: "SHOPPING_BUYER_TOKEN",
      backend: "local_marketplace",
    },
    model: {
      provider,
      model,
      api_key_env: apiKeyEnv,
      ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
    },
    runtime: {
      mode: "once",
      poll_interval_seconds: 5,
      turn_timeout_seconds: 90,
      max_model_steps: 4,
      max_retries: 2,
    },
    buyer_policy: {
      target_skus: [],
      quantity: 1,
      max_total_price_private: 1_000_000,
      acceptable_eta_latest: "2099-12-31T23:59:59+08:00",
      required_after_sales_terms: [],
      auto_negotiate: true,
      human_review_on: [],
    },
  };
}

/**
 * Main conversation (v0.3.0-A): build the AgentKernel for a profile.
 * provider=fake runs the deterministic offline chat fake; real providers
 * resolve models and auth through pi-ai's built-in provider catalog.
 * `catalog` 是 agent catalog base URL（buyer 的 negotiate_buyer_task 发现商家用）。
 */
async function buildChatKernel(
  profile: AgentProfile,
  dataDir?: string,
  catalog?: string,
): Promise<AgentKernel> {
  const paths = ensurePathsForDir(dataDir ?? agentDataDir(profile.agent_id));

  let models: AgentKernelOptions["models"];
  let model: AgentKernelOptions["model"];
  let connector: AgentKernelOptions["connector"];
  let thinkingLevel: ReturnType<typeof resolveThinkingLevel>;
  let merchantClient: AgentKernelOptions["merchantClient"];
  let broker: AgentKernelOptions["broker"];
  let commerceClient: AgentKernelOptions["commerceClient"];
  if (isFakeProvider(profile)) {
    ({ models, model } = createFakeChatModels());
    if (profile.role === "buyer") {
      const { FakeCommerceConnector, fakeConnectorProduct } = await import(
        "./agent/connector/fake-connector.js"
      );
      connector = new FakeCommerceConnector([
        fakeConnectorProduct(),
        fakeConnectorProduct({
          sku: "sku-002",
          title: "机制陶瓷杯",
          price: 59,
          stock: 0,
          merchant_id: "merchant-002",
        }),
      ]);
    } else {
      // Offline merchant chat: deterministic catalog client + dummy-scope
      // credentials so the capability pack is exercisable without a gateway.
      const { FakeMerchantClient, fakeMerchantProduct } = await import(
        "./agent/merchant/fake-merchant-client.js"
      );
      const { StaticCredentialBroker } = await import(
        "./agent/merchant/credential-broker.js"
      );
      merchantClient = new FakeMerchantClient({
        products: [fakeMerchantProduct()],
      });
      broker = new StaticCredentialBroker({
        negotiation: "fake-negotiation-token",
        catalog: "fake-catalog-token",
        inventory: "fake-inventory-token",
      });
    }
  } else {
    const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
    const collection = builtinModels();
    const found = collection.getModel(profile.model.provider, profile.model.model);
    if (found === undefined) {
      process.stderr.write(
        `no built-in model ${profile.model.provider}/${profile.model.model}; check the profile\n`,
      );
      throw new ProfileError(`no built-in model ${profile.model.provider}/${profile.model.model}`);
    }
    models = collection;
    model = found;
    thinkingLevel = resolveThinkingLevel(profile);
    if (profile.role === "buyer") {
      const { ShoppingCliConnector } = await import("./agent/connector/http-connector.js");
      connector = new ShoppingCliConnector(profile.commerce.base_url, {
        buyerBootstrapToken: process.env.SHOPPING_BUYER_BOOTSTRAP_TOKEN,
      });
    }
    // Real gateway: negotiation client + scoped merchant client + broker.
    const { ProfileCredentialBroker } = await import(
      "./agent/merchant/credential-broker.js"
    );
    broker = new ProfileCredentialBroker(profile);
    try {
      commerceClient = buildClient(profile);
    } catch {
      // No negotiation token: negotiation tools fail closed at call time.
      // Catalog/inventory 只读工具走公开搜索端点，不依赖该 token，仍会挂载。
      commerceClient = undefined;
      if (profile.role === "merchant") {
        process.stderr.write(
          `[kiwi] 未设置 ${profile.commerce.token_env}：磋商工具停用（fail closed），` +
            "目录/库存只读工具仍可用。\n",
        );
      }
    }
    if (profile.role === "merchant") {
      const { HttpMerchantClient } = await import("./agent/merchant/merchant-client.js");
      merchantClient = new HttpMerchantClient(profile.commerce.base_url, broker);
    }
  }

  // KIWI_MODE env: start the chat already in the given write mode (e.g.
  // autopilot for autonomous negotiation) — no manual /mode needed.
  const kiwiMode = process.env.KIWI_MODE;
  const mode: AgentMode | undefined = isAgentMode(kiwiMode) ? kiwiMode : undefined;
  if (kiwiMode !== undefined && mode === undefined) {
    process.stderr.write(`unknown KIWI_MODE ${kiwiMode}（可选 ${["manual", "supervised", "autopilot"].join("/")}）\n`);
  }

  return AgentKernel.open({
    profile,
    paths,
    models,
    model,
    ...(mode !== undefined ? { mode } : {}),
    ...(connector !== undefined ? { connector } : {}),
    ...(commerceClient !== undefined ? { commerceClient } : {}),
    ...(merchantClient !== undefined ? { merchantClient } : {}),
    ...(broker !== undefined ? { broker } : {}),
    ...(catalog !== undefined ? { catalog } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  });
}

/** kiwi 包根目录（dist/cli.js 的上级）——全局 `kiwi` 在任意 cwd 也能解析示例 profile。 */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

/**
 * `/profile <name>` 快捷解析：`merchant` → <包根>/examples/profiles/merchant.fake.yaml
 * （依次试 fake/local/裸名）。含路径或 .yaml/.yml 后缀时原样使用（相对 cwd）。
 */
function resolveProfilePath(file: string): string {
  if (file.includes("/") || file.endsWith(".yaml") || file.endsWith(".yml")) return file;
  const root = packageRoot();
  const candidates = [
    path.join(root, "examples", "profiles", `${file}.fake.yaml`),
    path.join(root, "examples", "profiles", `${file}.local.yaml`),
    path.join(root, "examples", "profiles", `${file}.yaml`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return file; // 原路径，让 loadProfile 抛原始错误
}

/**
 * Main conversation (v0.3.0-A): the AgentKernel with persistent session and
 * Principal Memory. 裸 `kiwi`（无 --profile）用 defaultChatProfile 直接进入
 * `kiwi>` 对话；`/profile <file>` 在对话内切换 kernel。
 */
async function cmdChat(args: ParsedArgs): Promise<number> {
  const profile = args.profile !== undefined ? loadProfile(args.profile) : defaultChatProfile();
  // A2A 节点 + buyer 磋商工具共用一个 catalog：kernel 构建前先解析。
  const catalog = args.catalog ?? process.env.KIWI_CATALOG_URL ?? "http://127.0.0.1:8600";
  const kernel = await buildChatKernel(profile, args.dataDir, catalog);
  const kernels: AgentKernel[] = [kernel];
  const reload = async (file: string): Promise<AgentKernel> => {
    const next = await buildChatKernel(loadProfile(resolveProfilePath(file)), args.dataDir, catalog);
    kernels.push(next);
    return next;
  };
  let node: A2aNodeHandle | null = null;
  const a2aNode: ChatA2aNode = {
    status: () =>
      node === null
        ? null
        : {
            role: node.role,
            url: node.url,
            agentCardUrl: node.agentCardUrl,
            ...(node.catalogAgentId !== undefined ? { catalogAgentId: node.catalogAgentId } : {}),
          },
    rebuild: async (p) => {
      await node?.stop().catch(() => undefined);
      node = await startA2aNode({
        profile: p as AgentProfile,
        catalog,
        preferredPort: args.port,
        ownerTokenSecret: process.env.KIWI_CATALOG_OWNER_TOKEN_SECRET,
      });
      process.stderr.write(
        `[a2a] ${node.role}@${node.url}${node.catalogAgentId !== undefined ? ` registered ${node.catalogAgentId}` : ""}\n`,
      );
    },
    stop: async () => {
      await node?.stop().catch(() => undefined);
      node = null;
    },
  };
  if (!args.noA2a) {
    try {
      await a2aNode.rebuild(profile);
    } catch (err) {
      process.stderr.write(`[a2a] 节点启动失败（对话继续）：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // SIGINT/SIGTERM → 优雅关闭（flush harness 会话 + close kernel/DB）。
  // 此前裸 `kiwi`/`kiwi chat` 在模型回合中途 Ctrl+C 直接终止，kernel.close()
  // 被跳过（与 agent serve 的信号处理对齐）。
  const shutdown = async (): Promise<void> => {
    for (const k of kernels) await k.close().catch(() => undefined);
    await a2aNode.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    return await runChatTui({
      kernel,
      input: process.stdin,
      output: process.stdout,
      reload,
      a2aNode,
      catalog,
    });
  } catch (err) {
    process.stderr.write(`unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.TRANSIENT;
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    for (const k of kernels) await k.close().catch(() => undefined);
    await a2aNode.stop().catch(() => undefined);
  }
}

/**
 * 产品层 buyer 命令树（rev1.1 §2.2/§19 D4）。
 * - start = chat 别名（Buyer 对话入口，既有实现）；
 * - init/search/tasks = D4 骨架（输出"尚未实现"提示，不假装可用）。
 */
async function routeBuyer(sub: string | undefined, args: ParsedArgs): Promise<number> {
  if (sub === undefined) {
    process.stdout.write(productHelp("buyer"));
    return EXIT.OK;
  }
  if (sub === "start") return await cmdChat(args);
  if (sub === "init") return await cmdBuyerInit(args);
  if (sub === "search") return await cmdBuyerSearch(args);
  if (sub === "tasks") return await cmdBuyerTasks(args);
  process.stderr.write(`unknown buyer command: ${sub}\n`);
  return EXIT.CONFIG;
}

/** `kiwi buyer init`（D4）：生成 buyer profile（无需 shopping-cli）。 */
async function cmdBuyerInit(args: ParsedArgs): Promise<number> {
  // 身份可选：缺省自动生成（buyer-<hostname>-<随机>）；显式指定用于跨设备延续
  const agentId = args.agentId ?? process.env.KIWI_BUYER_AGENT_ID ?? "";
  const report = buyerInit({
    agentId,
    ...(args.ownerId !== undefined ? { ownerId: args.ownerId } : {}),
    ...(args.autoNegotiate ? { autoNegotiate: true } : {}),
    ...(args.output !== undefined ? { outputPath: args.output } : {}),
    ...(args.force ? { force: true } : {}),
  });
  printJson(report);
  return report.ok ? EXIT.OK : EXIT.CONFIG;
}

/** `kiwi buyer search`（D4）：Product-first 搜索（M3 链路）。 */
async function cmdBuyerSearch(args: ParsedArgs): Promise<number> {
  // command = ["buyer", "search", <query...>]
  const query = args.command.slice(2).join(" ");
  if (!query) {
    process.stderr.write("search 需要一个查询描述（如：kiwi buyer search 21.5寸工业触摸屏）\n");
    return EXIT.CONFIG;
  }
  const catalog = args.catalog ?? process.env.KIWI_CATALOG_URL ?? "http://127.0.0.1:8600";
  const limit = args.limit !== undefined ? Number(args.limit) : undefined;
  if (args.limit !== undefined && (!Number.isInteger(limit) || (limit ?? 0) <= 0)) {
    process.stderr.write("--limit 必须是正整数\n");
    return EXIT.CONFIG;
  }
  try {
    const hits = await buyerSearch({
      query,
      catalogUrl: catalog,
      ...(limit !== undefined ? { limit } : {}),
      ...(args.category !== undefined ? { category: args.category } : {}),
      ...(args.region !== undefined ? { region: args.region } : {}),
      ...(args.listingType === "product" || args.listingType === "capability"
        ? { listingType: args.listingType }
        : {}),
    });
    printJson({ ok: true, count: hits.length, results: hits });
    return hits.length > 0 ? EXIT.OK : EXIT.CONFIG;
  } catch (err) {
    process.stderr.write(
      `搜索失败：${err instanceof Error ? err.message : String(err)}（Kiwi Network ${catalog} 不可达？）\n`,
    );
    return EXIT.CONFIG;
  }
}

/** `kiwi buyer tasks`（D4）：读本地任务列表。 */
async function cmdBuyerTasks(args: ParsedArgs): Promise<number> {
  try {
    const tasks = await buyerTasks({
      ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
      ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
    });
    printJson({ ok: true, count: tasks.length, tasks });
    return EXIT.OK;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.CONFIG;
  }
}

/**
 * 产品层 merchant 命令树（rev1.1 §2.3/§19 D1-D3）。
 * - start = agent serve 别名（Merchant A2A server + 注册 Kiwi Network）；
 * - init/publish/listings/status/doctor = 骨架（对应 D1/D2/D3）。
 */
async function routeMerchant(sub: string | undefined, args: ParsedArgs): Promise<number> {
  if (sub === undefined) {
    process.stdout.write(productHelp("merchant"));
    return EXIT.OK;
  }
  if (sub === "start") return await cmdAgentServe(args);
  if (sub === "init") return await cmdMerchantInit(args);
  if (sub === "publish") return await cmdMerchantPublish(args);
  if (sub === "listings") return notImplementedProduct("kiwi merchant listings", "D2");
  if (sub === "status") return notImplementedProduct("kiwi merchant status", "D1");
  if (sub === "doctor") return notImplementedProduct("kiwi merchant doctor", "D3");
  process.stderr.write(`unknown merchant command: ${sub}\n`);
  return EXIT.CONFIG;
}

/**
 * `kiwi merchant init`（D1）：首次初始化引导（rev1.1 §3.2/§19 D1）。
 * 生成可直接使用的 merchant profile（agent_id = shopping-cli merchant_id，
 * D2 身份统一）；shopping-cli 缺失/不可达记 warning 不阻塞。
 */
async function cmdMerchantInit(args: ParsedArgs): Promise<number> {
  // --merchant-id / --name flag 优先，env 回退（历史教训：help 文案承诺的
  // flag 从未被 parseArgs 解析，按 help 执行 100% Unknown argument）。
  const merchantId = args.merchantId ?? process.env.KIWI_MERCHANT_ID ?? "";
  const name = args.merchantName ?? process.env.KIWI_MERCHANT_NAME ?? "";
  if (!name) {
    process.stderr.write(
      "--name <商家名称> 是必需的（或 KIWI_MERCHANT_NAME）——它是你在网络上的" +
        "公开商家名称，Kiwi 不能替商家起名。\n",
    );
    return EXIT.CONFIG;
  }
  const report = await merchantInit({
    merchantName: name,
    ...(merchantId !== "" ? { merchantId } : {}),
    shoppingCliUrl: process.env.SHOPPING_CLI_URL ?? "http://127.0.0.1:8765",
    shoppingCliDb: process.env.SHOPPING_DB_PATH,
    catalogUrl: args.catalog ?? process.env.KIWI_CATALOG_URL ?? "http://127.0.0.1:8600",
    floorPriceMinor: 0,
    ...(args.output !== undefined ? { outputPath: args.output } : {}),
    ...(args.force ? { force: true } : {}),
    // 数据引擎默认自动安装（合一体验）；--no-install 显式禁用（受限/CI）
    autoInstallShoppingCli: !args.noInstall,
  });
  printJson(report);
  for (const warning of report.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  return report.ok ? EXIT.OK : EXIT.CONFIG;
}

/**
 * `kiwi merchant publish`（D2）：编排 agent 注册 + listing 发布（rev1.1 §4.5）。
 * fail-closed：任一步失败 → 非零退出 + 分步报告，不假装全成功。
 */
async function cmdMerchantPublish(args: ParsedArgs): Promise<number> {
  const profile = requireProfile(args);
  if (profile.role !== "merchant") {
    process.stderr.write("kiwi merchant publish 需要 merchant profile（role: merchant）\n");
    return EXIT.CONFIG;
  }
  const shoppingCliDb = args.shoppingCliDb ?? process.env.SHOPPING_DB_PATH;
  if (!shoppingCliDb) {
    process.stderr.write(
      "--shopping-cli-db <path>（或 SHOPPING_DB_PATH）是必需的：shopping-cli 的 SQLite 数据库路径\n",
    );
    return EXIT.CONFIG;
  }
  if (!existsSync(shoppingCliDb)) {
    process.stderr.write(`shopping-cli 数据库不存在：${shoppingCliDb}\n`);
    return EXIT.CONFIG;
  }
  const ownerTokenSecret = process.env.KIWI_CATALOG_OWNER_TOKEN_SECRET;
  if (!ownerTokenSecret) {
    process.stderr.write(
      "KIWI_CATALOG_OWNER_TOKEN_SECRET 是必需的（owner token 派生，与 kiwi-catalog 一致）\n",
    );
    return EXIT.CONFIG;
  }
  const catalog = args.catalog ?? process.env.KIWI_CATALOG_URL ?? "http://127.0.0.1:8600";
  const report = await merchantPublish({
    profile,
    catalogBaseUrl: catalog,
    ownerTokenSecret,
    shoppingCliDb,
    ...(args.shoppingCliPath !== undefined ? { shoppingCliPath: args.shoppingCliPath } : {}),
    ...(args.shoppingCliMerchant !== undefined
      ? { shoppingCliMerchant: args.shoppingCliMerchant }
      : {}),
  });
  printJson(report);
  return report.ok ? EXIT.OK : EXIT.CONFIG;
}

/** 产品层 network 命令树（rev1.1 §5）——Operator 面规划中，全部骨架。 */
async function routeNetwork(sub: string | undefined): Promise<number> {
  if (sub === undefined) {
    process.stdout.write(productHelp("network"));
    return EXIT.OK;
  }
  return notImplementedProduct(`kiwi network ${sub}`, "§5（Network Operator 面）");
}

function notImplementedProduct(name: string, target: string): number {
  process.stderr.write(
    `${name} 尚未实现（产品层完成定义 ${target}，见 docs/kiwi-product-layer-refactor-rev1.1.md §19）。\n`,
  );
  return EXIT.CONFIG;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const hasHelp = argv.includes("--help") || argv.includes("-h");
  const firstArg = argv.find((a) => !a.startsWith("-"));
  // 产品层命令组帮助优先于全局帮助（`kiwi buyer --help` → buyer 帮助）
  if (hasHelp && (firstArg === "buyer" || firstArg === "merchant" || firstArg === "network")) {
    const help = productHelp(firstArg);
    if (help !== "") {
      process.stdout.write(help);
      return EXIT.OK;
    }
  }
  if (hasHelp) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`kiwi ${PRODUCT_VERSION}\n`);
    return EXIT.OK;
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.CONFIG;
  }
  const [cmd, sub] = args.command;
  try {
    // 裸 `kiwi`：直接进入 `kiwi>` 自由对话（默认 deepseek-v4-flash，模型可配置）。
    if (cmd === undefined) return await cmdChat(args);
    // 产品层命令树（product-strategy rev1.1 §10/§19；别名保留旧命令）
    if (cmd === "buyer") return await routeBuyer(sub, args);
    if (cmd === "merchant") return await routeMerchant(sub, args);
    if (cmd === "network") return await routeNetwork(sub);
    if (cmd === "doctor") {
      // 无 --profile → 三组件聚合健康（D0）；有 → 既有 profile doctor
      return args.profile !== undefined ? await cmdDoctor(args) : await cmdProductDoctor();
    }
    if (cmd === "agent" && sub === "run") return await cmdAgentRun(args);
    if (cmd === "agent" && sub === "run") return await cmdAgentRun(args);
    if (cmd === "agent" && sub === "serve") return await cmdAgentServe(args);  // 旧命令别名保留
    if (cmd === "tui") return await cmdTui(args);
    if (cmd === "chat") return await cmdChat(args);
    if (cmd === "init") {
      const result = await runInit({
        dir: requireDir(args),
        ...(args.shoppingCliSrc !== undefined ? { shoppingCliSrc: args.shoppingCliSrc } : {}),
        ...(args.fake ? { fake: true } : {}),
      });
      printJson(result);
      return EXIT.OK;
    }
    if (cmd === "up") {
      printJson(await runUp(requireDir(args)));
      return EXIT.OK;
    }
    if (cmd === "status") {
      const result = await runStatus(requireDir(args));
      printJson(result);
      return result.ok ? EXIT.OK : EXIT.TRANSIENT;
    }
    if (cmd === "logs") {
      const result = runLogs(requireDir(args), parseLogLines(args.lines));
      for (const line of result.lines) process.stdout.write(`${line}\n`);
      if (result.lines.length === 0) {
        process.stderr.write("no log lines (processes not started yet or logs empty)\n");
      }
      return EXIT.OK;
    }
    if (cmd === "metrics") {
      // v0.7.0 #21：从 buyer agent data dir 的 Ledger 事件计算 KTH 指标。
      const dir = requireDir(args);
      const { HandoffEventStore, computeHandoffMetrics } = await import("./handoff/index.js");
      const ledger = new HandoffEventStore({ dir });
      const byNegotiation = new Map<string, ReturnType<typeof ledger.events>>();
      for (const nid of ledger.listNegotiations()) byNegotiation.set(nid, ledger.events(nid));
      printJson(computeHandoffMetrics(byNegotiation));
      return EXIT.OK;
    }
    if (cmd === "down") {
      const result = await runDown(requireDir(args));
      printJson(result);
      const failed = result.results.some((r) => r.outcome === "unverified");
      return failed ? EXIT.TRANSIENT : EXIT.OK;
    }
    process.stderr.write(USAGE);
    return EXIT.CONFIG;
  } catch (err) {
    if (err instanceof ProfileError || err instanceof StackConfigError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.CONFIG;
    }
    if (err instanceof SupervisorError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.TRANSIENT;
    }
    throw err;
  }
}

// Run only when executed as the CLI entrypoint (importable for tests).
// Robust against npm .bin symlinks: argv[1] is the symlink path while
// import.meta.url is the real file — compare both after realpath.
export function isInvokedAsScript(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined || argv1 === "") return false;
  const selfPath = fileURLToPath(import.meta.url);
  const argvPath = path.resolve(argv1);
  try {
    return realpathSync(selfPath) === realpathSync(argvPath);
  } catch {
    // Missing/deleted argv path (or self): fall back to unresolved compare.
    return selfPath === argvPath;
  }
}
if (isInvokedAsScript()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = EXIT.TRANSIENT;
    });
}
