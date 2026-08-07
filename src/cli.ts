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
import { A2AServer } from "./a2a/server/index.js";
import { createMerchantHandler } from "./a2a/server/merchant-handler.js";
import { LedgerStore } from "./negotiation/ledger/index.js";
import { IdempotencyStore } from "./negotiation/idempotency/index.js";
import { registerCatalogAgent } from "./discovery/catalog-source/register.js";
import { runChatTui } from "./agent/chat-tui.js";
import { createFakeChatModels } from "./agent/fake-chat-model.js";
import { isAgentMode, type AgentMode } from "./agent/mode.js";
import { AgentKernel, type AgentKernelOptions } from "./agent/kernel.js";
import { loadProfile, ProfileError, resolveSecret, type AgentProfile } from "./config/profile.js";
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

const USAGE = `kiwi 1.0.0 — commerce negotiation agent runtime

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
  kiwi agent serve --profile <file> [--catalog <url>] [--port N]
                                          Run a merchant A2A server + register in kiwi-catalog
  kiwi tui --profile <file> [--data-dir <dir>]
                                          Interactive operator TUI (supervised by default;
                                          approves candidates before any formal submit)
  kiwi chat --profile <file> [--data-dir <dir>]
                                          Main conversation with Principal Memory (v0.3.0-A)
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
  dataDir?: string;
  once: boolean;
  fake: boolean;
  catalog?: string;
  port?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  let profile: string | undefined;
  let dir: string | undefined;
  let lines: string | undefined;
  let shoppingCliSrc: string | undefined;
  let dataDir: string | undefined;
  let catalog: string | undefined;
  let port: number | undefined;
  let once = false;
  let fake = false;
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
    } else if (arg !== undefined && arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else if (arg !== undefined && arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg !== undefined && arg.startsWith("--lines=")) {
      lines = arg.slice("--lines=".length);
    } else if (arg !== undefined && arg.startsWith("--shopping-cli-src=")) {
      shoppingCliSrc = arg.slice("--shopping-cli-src=".length);
    } else if (arg !== undefined && arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else if (arg !== undefined && !arg.startsWith("-")) {
      command.push(arg);
    } else {
      throw new ProfileError(`Unknown argument: ${arg ?? ""}`);
    }
  }
  const out: ParsedArgs = { command, once, fake };
  if (profile !== undefined) out.profile = profile;
  if (dir !== undefined) out.dir = dir;
  if (lines !== undefined) out.lines = lines;
  if (shoppingCliSrc !== undefined) out.shoppingCliSrc = shoppingCliSrc;
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
  const port = args.port ?? 9000;
  const catalog = args.catalog ?? "http://127.0.0.1:8600";
  const paths = ensurePathsForDir(args.dataDir ?? agentDataDir(profile.agent_id));
  const dir = paths.dir;

  // 单调递增时钟：同内容事件在同一毫秒会触发 ledger 内容去重。
  let tick = 0;
  const clockBase = Date.parse("2026-08-07T00:00:00.000Z");
  const now = (): string => {
    const t = new Date(clockBase + tick);
    tick += 1;
    return t.toISOString();
  };

  const ledger = new LedgerStore({ dir, now });
  const idempotency = new IdempotencyStore({ dir, now });
  const handler = createMerchantHandler({
    ledger,
    now,
    sender: profile.agent_id,
    counterparty: "buyer:*",
  });

  const holder = { baseUrl: `http://127.0.0.1:${port}` };
  const server = new A2AServer({
    // A2AServerOptions.card 是 AgentCardConfigProvider：返回 config，server 内部再 buildAgentCard。
    // name 用干净显示名，不掺 agent_id（形如 agent:token，会被 card secret 扫描器判为 card_has_secret）。
    card: () => ({
      name: "Kiwi A2A Merchant",
      description: "Kiwi A2A merchant",
      providerOrganization: "Kiwi",
      version: "1.0.0",
      baseUrl: holder.baseUrl,
      a2aPath: "/",
    }),
    ledger,
    idempotency,
    handler,
    now,
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve()));
  holder.baseUrl = `http://127.0.0.1:${port}`;
  const agentCardUrl = `${holder.baseUrl}/.well-known/agent-card.json`;
  console.log(`[agent serve] merchant ${profile.agent_id} A2A server: ${agentCardUrl}`);

  // 注册进 kiwi-catalog（buyer 据此发现）。
  const domain =
    process.env.KIWI_CATALOG_DOMAIN ?? `merchant-${profile.agent_id.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}.local`;
  try {
    const reg = await registerCatalogAgent({
      catalogBaseUrl: catalog,
      domain,
      agentCardUrl,
      ucpProfileUrl: `${holder.baseUrl}/.well-known/ucp`,
      merchantId: profile.agent_id,
      ownerTokenSecret: process.env.KIWI_CATALOG_OWNER_TOKEN_SECRET,
    });
    console.log(
      `[agent serve] registered in catalog ${catalog}: ${reg.catalogAgentId ?? "?"} (${reg.status ?? "?"})`,
    );
  } catch (err) {
    process.stderr.write(
      `[agent serve] catalog 注册失败（A2A server 仍运行）：${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const shutdown = async (): Promise<void> => {
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log("[agent serve] listening — Ctrl+C to stop");
  // 永不返回：server 持续监听，直到 SIGINT/SIGTERM 触发 shutdown（process.exit）。
  await new Promise<never>(() => {});
  return EXIT.OK;
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
    runtime_version: "1.0.0",
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
 */
async function buildChatKernel(profile: AgentProfile, dataDir?: string): Promise<AgentKernel> {
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
      commerceClient = undefined;
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
  const kernel = await buildChatKernel(profile, args.dataDir);
  const kernels: AgentKernel[] = [kernel];
  const reload = async (file: string): Promise<AgentKernel> => {
    const next = await buildChatKernel(loadProfile(resolveProfilePath(file)), args.dataDir);
    kernels.push(next);
    return next;
  };
  try {
    return await runChatTui({
      kernel,
      input: process.stdin,
      output: process.stdout,
      reload,
    });
  } catch (err) {
    process.stderr.write(`unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.TRANSIENT;
  } finally {
    for (const k of kernels) await k.close().catch(() => undefined);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  if (argv.includes("--version")) {
    process.stdout.write("kiwi 1.0.0\n");
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
    if (cmd === "doctor") return await cmdDoctor(args);
    if (cmd === "agent" && sub === "run") return await cmdAgentRun(args);
    if (cmd === "agent" && sub === "serve") return await cmdAgentServe(args);
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
