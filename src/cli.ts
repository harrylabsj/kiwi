#!/usr/bin/env node
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

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDataDir, ensurePathsForDir } from "./agent/agent-db.js";
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

const USAGE = `kiwi 0.3.0 — commerce negotiation agent runtime

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
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  let profile: string | undefined;
  let dir: string | undefined;
  let lines: string | undefined;
  let shoppingCliSrc: string | undefined;
  let dataDir: string | undefined;
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
 * Main conversation (v0.3.0-A): the AgentKernel with persistent session and
 * Principal Memory. provider=fake runs the deterministic offline chat fake;
 * real providers resolve models and auth through pi-ai's built-in provider
 * catalog (env conventions of the chosen provider).
 */
async function cmdChat(args: ParsedArgs): Promise<number> {
  const profile = requireProfile(args);
  const paths = ensurePathsForDir(args.dataDir ?? agentDataDir(profile.agent_id));

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
      return EXIT.CONFIG;
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

  const kernel = await AgentKernel.open({
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
  try {
    return await runChatTui({ kernel, input: process.stdin, output: process.stdout });
  } catch (err) {
    process.stderr.write(`unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.TRANSIENT;
  } finally {
    await kernel.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  if (argv.includes("--version")) {
    process.stdout.write("kiwi 0.3.0\n");
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
    if (cmd === "doctor") return await cmdDoctor(args);
    if (cmd === "agent" && sub === "run") return await cmdAgentRun(args);
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
