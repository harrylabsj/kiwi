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

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startA2aNode, type A2aNodeHandle } from "./a2a/node.js";
import type { ChatA2aNode } from "./agent/chat-tui.js";
import { runChatTui } from "./agent/chat-tui.js";
import { buildChatKernel, buildClient, defaultChatProfile } from "./agent/kernel-builder.js";

import { AgentKernel } from "./agent/kernel.js";
import { loadProfile, ProfileError, type AgentProfile } from "./config/profile.js";

import type { CommerceClient } from "./commerce/types.js";
import { CommerceError } from "./commerce/types.js";
import { runDoctor } from "./doctor.js";
import { EXIT } from "./exit-codes.js";
import { createDeterministicStreamFn } from "./runtime/fake-model.js";
import { runForeground } from "./runtime/foreground.js";
import { runNegotiationTurn, type TurnReport } from "./runtime/negotiation-turn.js";
import { isFakeProvider, realStreamFn } from "./runtime/model.js";
import { OperatorController } from "./operator/controller.js";
import { DeterministicNegotiationRunner } from "./operator/runner.js";
import { FileOperatorEventStore, OperatorStoreError } from "./operator/store.js";
import { createStrategyEngine } from "./operator/strategy.js";
import { runTui } from "./operator/tui.js";
import { runInit } from "./supervisor/init.js";
import { runMcpServe } from "./mcp/cli.js";
import { runHttpServe } from "./http/cli.js";
import { runDown, runStatus, runUp, SupervisorError } from "./supervisor/manage.js";
import { parseLogLines, runLogs } from "./supervisor/logs.js";
import { StackConfigError } from "./supervisor/stack-config.js";
import {
  cmdProductDoctor,
  productHelp,
  PRODUCT_VERSION,
  DEFAULT_CATALOG_URL,
  DEFAULT_PROFILE_PATH,
} from "./product-cli.js";
import { cmdWeixin, weixinUsage } from "./weixin/cli-weixin.js";
import { DEFAULT_SHOPPING_DB_PATH, loadMerchantCredentials, merchantInit, slugifyMerchantId } from "./product-init.js";
import readline from "node:readline";
import { buyerInit, buyerSearch, buyerTasks } from "./product-buyer.js";
import {
  supplierList,
  supplierMetrics,
  supplierPause,
  supplierPrefer,
  supplierRemove,
  supplierSave,
  supplierWatch,
} from "./product-supplier.js";
import { merchantStats } from "./product-merchant.js";
import { merchantPublish } from "./product-publish.js";
import { catalogServe } from "./product-catalog.js";
import { extractPublicDomain, runMerchantSetupPublic, SetupPublicError, validatePublicDomain } from "./product-setup-public.js";

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
  kiwi weixin [--profile <file>] [--allow id,...] [--relogin] [--a2a]
                                          WeChat remote control (scan QR to log in)
  kiwi metrics --dir <dir>                Handoff/negotiation ledger metrics (JSONL)
  kiwi catalog serve [--db <file>] [--host <host>] [--port <port>]
                                          Start the standalone kiwi-catalog service
                                          (foreground; requires pip install kiwi-catalog)

Product layer (product-strategy rev1.1 §10/§19):
  kiwi buyer --help                       Kiwi Buyer command tree
  kiwi merchant --help                    Kiwi Merchant command tree
  kiwi setup-hermes                       One-click: wire kiwi-buyer-mcp into Hermes
                                          (hermes mcp add + skills install)
  kiwi network --help                     Kiwi Network command tree
  kiwi demo [a|b]                         One-command local multi-merchant demo
                                          (Issue 13; 1 buyer + catalog + 3 merchants
                                          + fan-out RFQ → Agreement → Handoff, no
                                          LLM/API key/no internet/no real transaction)
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

Public A2A exposure: KIWI_A2A_PUBLIC_URL=https://<domain> advertises the
public address (the node still binds 127.0.0.1 behind a reverse proxy);
KIWI_A2A_AUTH selects inbound auth — "loopback" (local development /
proxy-is-the-boundary only; a public advertised address prints a loud
warning), "none" (trusted networks/tests), or "bearer:<token>"
(recommended for public nodes).
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
  allowEmptyProjectionReconcile: boolean;
  merchantId?: string;
  merchantName?: string;
  output?: string;
  force: boolean;
  noInstall: boolean;
  agentId?: string;
  ownerId?: string;
  autoNegotiate: boolean;
  limit?: string;
  days?: string;
  category?: string;
  region?: string;
  listingType?: string;
  dataDir?: string;
  catalogDb?: string;
  catalogHost?: string;
  once: boolean;
  fake: boolean;
  catalog?: string;
  port?: number;
  noChat: boolean;
  noA2a: boolean;
  a2aExplicit: boolean;
  weixinAllow?: string;
  relogin: boolean;
  qrScale: number;
  noQr: boolean;
  domain?: string;
  check: boolean;
  caddyfile?: string;
  file?: string;
  yes: boolean;
  query?: string;
  interval?: string;
  scope?: string;
  expires?: string;
}

/** 导出供测试（审查 P2-L：--a2a flag 解析回归锁定）。 */
export function parseArgs(argv: string[]): ParsedArgs {
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
  let allowEmptyProjectionReconcile = false;
  let agentId: string | undefined;
  let ownerId: string | undefined;
  let autoNegotiate = false;
  let limit: string | undefined;
  let days: string | undefined;
  let category: string | undefined;
  let region: string | undefined;
  let listingType: string | undefined;
  let dataDir: string | undefined;
  let catalog: string | undefined;
  let port: number | undefined;
  let catalogDb: string | undefined;
  let catalogHost: string | undefined;
  let once = false;
  let fake = false;
  let noChat = false;
  let noA2a = false;
  let a2aExplicit = false;
  let weixinAllow: string | undefined;
  let relogin = false;
  let qrScale = 1;
  let noQr = false;
  let domain: string | undefined;
  let check = false;
  let caddyfile: string | undefined;
  let file: string | undefined;
  let yes = false;
  let query: string | undefined;
  let interval: string | undefined;
  let scope: string | undefined;
  let expires: string | undefined;
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
    } else if (arg === "--allow-empty-projection") {
      // 审查 P1-B：显式放行"投影为空时 reconcile 全量下架"（默认拒绝）
      allowEmptyProjectionReconcile = true;
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
    } else if (arg === "--days") {
      days = argv[++i];
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
      // 只接受十进制正整数（评审项 L5：Number("abc")=NaN 会流入 server.listen）
      const raw = argv[++i];
      const parsed = /^\d+$/.test(raw ?? "") ? Number(raw) : Number.NaN;
      port = Number.isInteger(parsed) ? parsed : undefined;
    } else if (arg === "--host") {
      catalogHost = argv[++i];
    } else if (arg === "--db") {
      catalogDb = argv[++i];
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--fake") {
      fake = true;
    } else if (arg === "--no-chat") {
      noChat = true;
    } else if (arg === "--no-a2a") {
      noA2a = true;
    } else if (arg === "--a2a") {
      // 审查 P2-L：weixin 命令文档承诺"A2A 节点默认关，--a2a 开启"——
      // 此前 parseArgs 无此分支（Unknown argument: --a2a，实测 exit 2），
      // 且默认 noA2a=false 让 A2A 恒开（与文档相反，需 --no-a2a 才能关）。
      // 裸 kiwi 命令的 A2A 默认开不受影响（见 cmdWeixin 的解析）。
      a2aExplicit = true;
    } else if (arg === "--allow") {
      weixinAllow = argv[++i];
    } else if (arg === "--relogin") {
      relogin = true;
    } else if (arg === "--qr-scale") {
      const raw = argv[++i];
      qrScale = raw === "2" ? 2 : 1;
    } else if (arg === "--no-qr") {
      noQr = true;
    } else if (arg === "--domain") {
      domain = argv[++i];
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--caddyfile") {
      caddyfile = argv[++i];
    } else if (arg === "--file") {
      file = argv[++i];
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--query") {
      query = argv[++i];
    } else if (arg === "--interval") {
      interval = argv[++i];
    } else if (arg === "--scope") {
      scope = argv[++i];
    } else if (arg === "--expires") {
      expires = argv[++i];
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
    } else if (arg !== undefined && arg.startsWith("--days=")) {
      days = arg.slice("--days=".length);
    } else if (arg !== undefined && arg.startsWith("--domain=")) {
      domain = arg.slice("--domain=".length);
    } else if (arg !== undefined && arg.startsWith("--caddyfile=")) {
      caddyfile = arg.slice("--caddyfile=".length);
    } else if (arg !== undefined && arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
    } else if (arg !== undefined && arg.startsWith("--query=")) {
      query = arg.slice("--query=".length);
    } else if (arg !== undefined && arg.startsWith("--interval=")) {
      interval = arg.slice("--interval=".length);
    } else if (arg !== undefined && arg.startsWith("--scope=")) {
      scope = arg.slice("--scope=".length);
    } else if (arg !== undefined && arg.startsWith("--expires=")) {
      expires = arg.slice("--expires=".length);
    } else if (arg !== undefined && !arg.startsWith("-")) {
      command.push(arg);
    } else {
      throw new ProfileError(`Unknown argument: ${arg ?? ""}`);
    }
  }
  const out: ParsedArgs = {
    command,
    once,
    fake,
    noChat,
    noA2a,
    a2aExplicit,
    force,
    noInstall,
    autoNegotiate,
    allowEmptyProjectionReconcile,
    weixinAllow,
    relogin,
    qrScale,
    noQr,
    check,
    yes,
  };
  if (profile !== undefined) out.profile = profile;
  if (dir !== undefined) out.dir = dir;
  if (lines !== undefined) out.lines = lines;
  if (shoppingCliSrc !== undefined) out.shoppingCliSrc = shoppingCliSrc;
  if (shoppingCliDb !== undefined) out.shoppingCliDb = shoppingCliDb;
  if (shoppingCliPath !== undefined) out.shoppingCliPath = shoppingCliPath;
  if (shoppingCliMerchant !== undefined) out.shoppingCliMerchant = shoppingCliMerchant;
  if (allowEmptyProjectionReconcile) out.allowEmptyProjectionReconcile = true;
  if (merchantId !== undefined) out.merchantId = merchantId;
  if (merchantName !== undefined) out.merchantName = merchantName;
  if (output !== undefined) out.output = output;
  if (agentId !== undefined) out.agentId = agentId;
  if (ownerId !== undefined) out.ownerId = ownerId;
  if (limit !== undefined) out.limit = limit;
  if (days !== undefined) out.days = days;
  if (category !== undefined) out.category = category;
  if (region !== undefined) out.region = region;
  if (listingType !== undefined) out.listingType = listingType;
  if (dataDir !== undefined) out.dataDir = dataDir;
  if (catalog !== undefined) out.catalog = catalog;
  if (port !== undefined) out.port = port;
  if (catalogDb !== undefined) out.catalogDb = catalogDb;
  if (domain !== undefined) out.domain = domain;
  if (caddyfile !== undefined) out.caddyfile = caddyfile;
  if (file !== undefined) out.file = file;
  if (catalogHost !== undefined) out.catalogHost = catalogHost;
  if (query !== undefined) out.query = query;
  if (interval !== undefined) out.interval = interval;
  if (scope !== undefined) out.scope = scope;
  if (expires !== undefined) out.expires = expires;
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

/**
 * 读取 profile：`--profile` 优先；缺省回退 `KIWI_DEFAULT_PROFILE` env 或
 * `DEFAULT_PROFILE_PATH`（`kiwi merchant init` 写入的默认路径）。文件不存在 →
 * fail-closed 提示先 init。供商家命令（start/publish/setup-public）参数化使用，
 * 让第 4-5 步不带 `--profile`。
 */
function requireProfileOrDefault(args: ParsedArgs): AgentProfile {
  if (args.profile) return loadProfile(args.profile);
  const fallback = process.env.KIWI_DEFAULT_PROFILE ?? DEFAULT_PROFILE_PATH;
  if (existsSync(fallback)) return loadProfile(fallback);
  throw new ProfileError(
    `未找到商家配置（${fallback}）——先运行 kiwi merchant init，或用 --profile <file> 指定`,
  );
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
 *   kiwi agent serve --profile <merchant.yaml> [--catalog <url>]  # 缺省官方 catalog，本地自托管用 --catalog http://127.0.0.1:8600
 *                    [--port 9000] [--data-dir <dir>]
 *
 * 公网暴露：节点仍监听 127.0.0.1，但可用 KIWI_A2A_PUBLIC_URL=<https://domain>
 * 覆盖 Agent Card / UCP / catalog 注册广告的公网地址（配合 Caddy/Nginx 反代）。
 */

/** 审查 P1-09：agent serve 的 A2A 状态目录。缺省用稳定路径
 *  `<cwd>/.kiwi/agents/<agent_id>`（与 operator 路径共用同一缺省）——重启后
 *  Ledger/幂等/终态可恢复；显式 --data-dir 覆盖。绝不回退到临时目录。 */
export function resolveServeDataDir(dataDir: string | undefined, agentId: string): string {
  return dataDir ?? path.resolve(".kiwi", "agents", agentId);
}
async function cmdAgentServe(args: ParsedArgs): Promise<number> {
  const profile = requireProfileOrDefault(args);
  if (profile.role !== "merchant") {
    process.stderr.write("kiwi agent serve 需要 merchant profile（role: merchant）\n");
    return EXIT.CONFIG;
  }
  loadMerchantCredentials(); // 加载 init 写入的 credentials.env（KIWI_MERCHANT_TOKEN）
  const catalog = args.catalog ?? process.env.KIWI_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const merchantToken = process.env.KIWI_MERCHANT_TOKEN || "";
  // 审查 P1-09：serve 的初始 A2A 节点必须用稳定 dataDir——此前初始节点缺省走
  // mkdtemp 临时目录且 stop 时删除，重启后 Ledger/幂等/终态全丢：已终态
  // negotiation 可重开、已发 conditional offer 返回 offer_unknown。稳定目录
  // 让重启可恢复状态（resolveServeDataDir 见上）。
  const serveDataDir = resolveServeDataDir(args.dataDir, profile.agent_id);
  const profilePublicUrl = profile.merchant_public?.public_url;
  let node: A2aNodeHandle | null = await startA2aNode({
    profile,
    catalog,
    preferredPort: args.port ?? profile.merchant_public?.a2a_port,
    dataDir: serveDataDir,
    ...(profilePublicUrl ? { publicBaseUrl: `https://${profilePublicUrl}` } : {}),
    ...(merchantToken ? { ownerToken: merchantToken } : {}),
    ownerTokenSecret: process.env.KIWI_CATALOG_OWNER_TOKEN_SECRET,
  });
  console.log(
    `[agent serve] merchant ${profile.agent_id} A2A server: ${node.agentCardUrl}` +
      (node.advertisedUrl !== node.url ? ` (local ${node.url})` : ""),
  );
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
        dataDir: serveDataDir,
        ...(merchantToken ? { ownerToken: merchantToken } : {}),
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

/**
 * Main conversation (v0.3.0-A): build the AgentKernel for a profile.
 * provider=fake runs the deterministic offline chat fake; real providers
 * resolve models and auth through pi-ai's built-in provider catalog.
 * `catalog` 是 agent catalog base URL（buyer 的 negotiate_buyer_task 发现商家用）。
 */

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
export function resolveChatProfile(
  explicitProfile: string | undefined,
  requiredRole?: AgentProfile["role"],
  defaultProfilePath: string = DEFAULT_PROFILE_PATH,
): AgentProfile {
  // 裸 `kiwi`：优先用 `kiwi buyer/merchant init` 写下的默认 profile
  //（~/.kiwi/kiwi.yaml）；没有才回退内置 buyer 默认。
  let profile: AgentProfile;
  if (explicitProfile !== undefined) {
    profile = loadProfile(explicitProfile);
  } else if (existsSync(defaultProfilePath)) {
    profile = loadProfile(defaultProfilePath);
  } else {
    profile = defaultChatProfile();
  }

  if (requiredRole === undefined || profile.role === requiredRole) return profile;

  // `kiwi buyer start` is an explicit product entry point.  A merchant
  // default profile must not silently turn it into a merchant conversation;
  // use the built-in buyer profile when no profile was explicitly supplied.
  if (explicitProfile === undefined && requiredRole === "buyer") {
    return defaultChatProfile();
  }

  throw new ProfileError(
    `kiwi ${requiredRole} start 需要 ${requiredRole} profile；当前 profile 的 role 是 ${profile.role}。` +
      ` 请使用 --profile 指向 ${requiredRole} profile。`,
  );
}

async function cmdChat(args: ParsedArgs, requiredRole?: AgentProfile["role"]): Promise<number> {
  const profile = resolveChatProfile(args.profile, requiredRole);
  // A2A 节点 + buyer 磋商工具共用一个 catalog：kernel 构建前先解析。
  const catalog = args.catalog ?? process.env.KIWI_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const merchantToken = process.env.KIWI_MERCHANT_TOKEN || "";
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
        // 审查：chat 起的 A2A 节点同样要持久 dataDir——否则 Ledger/幂等/签名密钥
        // 全落临时目录，重启后磋商状态与签名身份丢失（Issue 16 B）。
        dataDir: resolveServeDataDir(args.dataDir, (p as AgentProfile).agent_id),
        ...(merchantToken ? { ownerToken: merchantToken } : {}),
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
  if (sub === "start") return await cmdChat(args, "buyer");
  if (sub === "init") return await cmdBuyerInit(args);
  if (sub === "search") return await cmdBuyerSearch(args);
  if (sub === "tasks") return await cmdBuyerTasks(args);
  if (sub === "supplier") return await cmdBuyerSupplier(args);
  process.stderr.write(`unknown buyer command: ${sub}\n`);
  return EXIT.CONFIG;
}

/**
 * `kiwi buyer supplier ...`（pull-relationship 设计 v0.1 §11，M1）：
 * Buyer-owned 本地供应商关系命令。save/watch/prefer 需要经 kiwi-catalog
 * 解析 Merchant 公开 record；list/pause/remove 只操作本地 store。
 */
async function cmdBuyerSupplier(args: ParsedArgs): Promise<number> {
  // command = ["buyer", "supplier", <action>, <id...>]
  const action = args.command[2];
  const id = args.command[3];
  const base = {
    ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
    ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
  };
  const catalog = args.catalog ?? process.env.KIWI_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  /** watched/preferred 的人类明确确认：TTY 交互提问；非交互必须显式 --yes。 */
  const consent = {
    yes: args.yes,
    ...(process.stdin.isTTY && !args.yes
      ? {
          confirm: async (): Promise<boolean> => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer = await new Promise<string>((resolve) => {
                rl.question(
                  "确认建立该供应商观察/偏好关系（Buyer 本地定期拉取公开信息）？[y/N] ",
                  resolve,
                );
              });
              return answer.trim().toLowerCase() === "y";
            } finally {
              rl.close();
            }
          },
        }
      : {}),
  };
  try {
    if (action === "save" || action === "watch" || action === "prefer") {
      if (id === undefined || id === "") {
        process.stderr.write(`supplier ${action} 需要 <merchant-id>\n`);
        return EXIT.CONFIG;
      }
      if (action === "save") {
        printJson({ ok: true, relationship: await supplierSave({ ...base, merchantId: id, catalogUrl: catalog }) });
      } else if (action === "watch") {
        const intervalSeconds =
          args.interval !== undefined ? Number(args.interval) : undefined;
        if (args.interval !== undefined && !Number.isInteger(intervalSeconds)) {
          process.stderr.write("--interval 必须是整数秒（≥3600）\n");
          return EXIT.CONFIG;
        }
        printJson({
          ok: true,
          relationship: await supplierWatch({
            ...base,
            merchantId: id,
            catalogUrl: catalog,
            ...(args.query !== undefined ? { query: args.query } : {}),
            ...(args.region !== undefined ? { region: args.region } : {}),
            ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
            ...(args.expires !== undefined ? { expires: args.expires } : {}),
            ...consent,
          }),
        });
      } else {
        printJson({
          ok: true,
          relationship: await supplierPrefer({
            ...base,
            merchantId: id,
            catalogUrl: catalog,
            ...(args.scope !== undefined ? { scope: args.scope } : {}),
            ...(args.expires !== undefined ? { expires: args.expires } : {}),
            ...consent,
          }),
        });
      }
      return EXIT.OK;
    }
    if (action === "list") {
      const relationships = await supplierList(base);
      printJson({ ok: true, count: relationships.length, relationships });
      return EXIT.OK;
    }
    if (action === "metrics") {
      printJson({ ok: true, metrics: await supplierMetrics(base) });
      return EXIT.OK;
    }
    if (action === "pause" || action === "remove") {
      if (id === undefined || id === "") {
        process.stderr.write(`supplier ${action} 需要 <relationship-id>\n`);
        return EXIT.CONFIG;
      }
      const relationship =
        action === "pause"
          ? await supplierPause({ ...base, relationshipId: id })
          : await supplierRemove({ ...base, relationshipId: id });
      printJson({ ok: true, relationship });
      return EXIT.OK;
    }
    process.stderr.write(
      `unknown supplier command: ${action ?? ""}（save|watch|prefer|list|metrics|pause|remove）\n`,
    );
    return EXIT.CONFIG;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.CONFIG;
  }
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
  if (report.ok) {
    process.stdout.write(
      "✓ 商家配置完成。下一步：`kiwi merchant up` 上线（需先装 Caddy、DNS 指向服务器）；或 `kiwi merchant setup-public` 查看公网配置。\n",
    );
  }
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
  const catalog = args.catalog ?? process.env.KIWI_CATALOG_URL ?? DEFAULT_CATALOG_URL;
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
  if (sub === "setup-public") return await cmdMerchantSetupPublic(args);
  if (sub === "up") return await cmdMerchantUp(args);
  if (sub === "stats") return await cmdMerchantStats(args);
  if (sub === "listings") return notImplementedProduct("kiwi merchant listings", "D2");
  if (sub === "status") return notImplementedProduct("kiwi merchant status", "D1");
  if (sub === "doctor") return notImplementedProduct("kiwi merchant doctor", "D3");
  process.stderr.write(`unknown merchant command: ${sub}\n`);
  return EXIT.CONFIG;
}

/**
 * `kiwi merchant stats`：商家侧运营统计（本地数据，不上报）——
 * 多少个不同的买家联系过我、讨论了哪些 SKU。数据由 merchant A2A 节点
 * 在收到买家 KNP 消息时自动写入 <dataDir>/a2a/stats.sqlite。
 */
async function cmdMerchantStats(args: ParsedArgs): Promise<number> {
  const profile = requireProfileOrDefault(args);
  if (profile.role !== "merchant") {
    process.stderr.write("kiwi merchant stats 需要 merchant profile（role: merchant）\n");
    return EXIT.CONFIG;
  }
  let days: number | undefined;
  if (args.days !== undefined) {
    const parsed = Number(args.days);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      process.stderr.write("--days 必须是正整数\n");
      return EXIT.CONFIG;
    }
    days = parsed;
  }
  try {
    const report = merchantStats({
      agentId: profile.agent_id,
      dataDir: resolveServeDataDir(args.dataDir, profile.agent_id),
      ...(days !== undefined ? { days } : {}),
    });
    printJson(report);
    return EXIT.OK;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.CONFIG;
  }
}

/**
 * `kiwi merchant init`（D1）：首次初始化引导（rev1.1 §3.2/§19 D1）。
 * 生成可直接使用的 merchant profile（agent_id = shopping-cli merchant_id，
 * D2 身份统一）；shopping-cli 缺失/不可达记 warning 不阻塞。
 */
/** TTY 交互提示一行（非 TTY 返回缺省，不阻塞脚本）。 */
function promptLine(text: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve(fallback);
  process.stdout.write(text);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim() !== "" ? answer.trim() : fallback);
    });
  });
}

async function cmdMerchantInit(args: ParsedArgs): Promise<number> {
  // --merchant-id / --name flag 优先，env 回退；TTY 下交互提示，缺省自动派生。
  let merchantId = args.merchantId ?? process.env.KIWI_MERCHANT_ID ?? "";
  let name = args.merchantName ?? process.env.KIWI_MERCHANT_NAME ?? "";
  let publicUrl = "";
  let merchantToken = "";
  if (process.stdin.isTTY) {
    merchantId = await promptLine(
      `merchant_id（回车自动生成${name !== "" ? `，建议 ${slugifyMerchantId(name)}` : ""}）: `,
      merchantId,
    );
    name = await promptLine(`商家名称（回车用缺省）: `, name);
    publicUrl = await promptLine("公网域名（可选，回车跳过；如 merchant.example.com）: ", "");
    if (publicUrl !== "") publicUrl = publicUrl.trim().toLowerCase();
    merchantToken = await promptLine("商家令牌（从商家后台获取，可稍后设置；直接回车跳过）: ", "");
    // TTY 下可全回车：merchant_id 自动生成（避免固定名碰撞）。
    if (merchantId === "") merchantId = `merchant-${Math.random().toString(36).slice(2, 8)}`;
    if (name === "") name = merchantId;
  } else if (merchantId === "" && name === "") {
    // 非交互且无任何身份 → fail-closed（不自动生成碰撞身份）。
    process.stderr.write(
      "--merchant-id <id> 或 --name <商家名称> 至少填一个（TTY 下可交互回车自动生成）。\n",
    );
    return EXIT.CONFIG;
  } else {
    // 系统补全：merchant_id 缺省从名称派生；名称缺省用 merchant_id。
    if (merchantId === "") merchantId = slugifyMerchantId(name);
    if (name === "") name = merchantId;
  }
  const report = await merchantInit({
    merchantName: name,
    ...(merchantId !== "" ? { merchantId } : {}),
    ...(publicUrl !== "" ? { publicUrl } : {}),
    ...(merchantToken !== "" ? { merchantToken } : {}),
    shoppingCliUrl: process.env.SHOPPING_CLI_URL ?? "http://127.0.0.1:8765",
    shoppingCliDb: process.env.SHOPPING_DB_PATH,
    catalogUrl: args.catalog ?? process.env.KIWI_CATALOG_URL ?? DEFAULT_CATALOG_URL,
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
  const profile = requireProfileOrDefault(args);
  if (profile.role !== "merchant") {
    process.stderr.write("kiwi merchant publish 需要 merchant profile（role: merchant）\n");
    return EXIT.CONFIG;
  }
  loadMerchantCredentials(); // 加载 init 写入的 credentials.env（KIWI_MERCHANT_TOKEN）
  // 缺省路径与 shopping-cli 的 DEFAULT_DB_PATH 一致——商家无需设置 SHOPPING_DB_PATH。
  const shoppingCliDb =
    args.shoppingCliDb ?? process.env.SHOPPING_DB_PATH ?? DEFAULT_SHOPPING_DB_PATH;
  // `--file <csv>`：先导入商品（shopping-cli import-csv-excel）再发布。
  if (args.file !== undefined && args.file !== "") {
    const imp = spawnSync(
      "shopping-cli",
      ["import-csv-excel", "--file", args.file, "--merchant", profile.agent_id, "--format", "json"],
      { env: { ...process.env, SHOPPING_DB_PATH: shoppingCliDb }, stdio: "inherit" },
    );
    if (imp.status !== 0) {
      process.stderr.write(
        `商品导入失败（shopping-cli import-csv-excel 退出码 ${imp.status ?? "?"}）——请检查 CSV 格式\n`,
      );
      return EXIT.CONFIG;
    }
    process.stdout.write(`已导入商品：${args.file}\n`);
  }
  if (!existsSync(shoppingCliDb)) {
    process.stderr.write(
      `shopping-cli 数据库不存在：${shoppingCliDb}（先运行 shopping-cli import-csv-excel 导入商品）\n`,
    );
    return EXIT.CONFIG;
  }
  const ownerTokenSecret = process.env.KIWI_CATALOG_OWNER_TOKEN_SECRET;
  const merchantTokenEnv = profile.merchant_public?.merchant_token_env;
  const merchantToken =
    (merchantTokenEnv ? process.env[merchantTokenEnv] : undefined) || process.env.KIWI_MERCHANT_TOKEN || "";
  if (!merchantToken && !ownerTokenSecret) {
    process.stderr.write(
      "需要 KIWI_MERCHANT_TOKEN（随机 token，推荐）或 KIWI_CATALOG_OWNER_TOKEN_SECRET（legacy HMAC）\n",
    );
    return EXIT.CONFIG;
  }
  const catalog = args.catalog ?? profile.merchant_public?.catalog_url ?? process.env.KIWI_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const report = await merchantPublish({
    profile,
    catalogBaseUrl: catalog,
    ...(merchantToken ? { ownerToken: merchantToken } : {}),
    ...(ownerTokenSecret ? { ownerTokenSecret } : {}),
    shoppingCliDb,
    ...(args.shoppingCliPath !== undefined ? { shoppingCliPath: args.shoppingCliPath } : {}),
    ...(args.shoppingCliMerchant !== undefined
      ? { shoppingCliMerchant: args.shoppingCliMerchant }
      : {}),
    ...(args.allowEmptyProjectionReconcile
      ? { allowEmptyProjectionReconcile: true }
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

/**
 * `kiwi demo [a|b]`（Issue 13）：一条命令本地多商家演示。
 * 阶段可视化输出到 stderr，stdout 保持干净（可 JSON 消费）。
 */
async function cmdDemo(args: ParsedArgs): Promise<number> {
  const scenarioKey = args.command[1] ?? "a";
  const { runDemo, DEMO_SCENARIOS } = await import("./demo/demo-runner.js");
  if (DEMO_SCENARIOS[scenarioKey] === undefined) {
    process.stderr.write(`unknown demo scenario: ${scenarioKey}（可用 a / b）\n`);
    return EXIT.CONFIG;
  }
  try {
    await runDemo(scenarioKey, {
      onLog: (phase: string, detail: string) => process.stderr.write(`  [${phase}] ${detail}\n`),
    });
    return EXIT.OK;
  } catch (err) {
    process.stderr.write(`demo failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.TRANSIENT;
  }
}

/**
 * `kiwi merchant setup-public`（D3）——公网 A2A 暴露引导向导。
 * 检测公网 IP、检查域名 DNS、生成 Caddy 反代配置、输出启动与验证命令。
 * well-known 文件由跑着的 `kiwi merchant start` 节点自动生成，商家无需手写。
 */
async function cmdMerchantSetupPublic(args: ParsedArgs): Promise<number> {
  const profile = requireProfileOrDefault(args); // 无 --profile 时回退缺省 ~/.kiwi/kiwi.yaml
  const port = args.port ?? profile.merchant_public?.a2a_port ?? (Number(process.env.KIWI_A2A_PORT ?? "") || 9000); // 与 startA2aNode 缺省一致
  // 单一来源：--domain 显式 > profile.merchant_public.public_url（init 引导写入）>
  // KIWI_A2A_PUBLIC_URL env 提取；TTY 下再交互提示。
  let domain = args.domain ?? profile.merchant_public?.public_url ?? extractPublicDomain(process.env.KIWI_A2A_PUBLIC_URL) ?? "";
  if (domain === "" && process.stdin.isTTY) {
    domain = await promptLine("公网域名（如 merchant.example.com，TLS 证书就用它）: ", "");
  }
  if (domain === "") {
    process.stderr.write(
      "--domain <公网域名> 必填（TTY 下可交互输入）。例：kiwi merchant setup-public --domain merchant.example.com\n",
    );
    return EXIT.CONFIG;
  }
  let normalized: string;
  try {
    normalized = validatePublicDomain(domain);
  } catch (err) {
    if (err instanceof SetupPublicError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.CONFIG;
    }
    throw err;
  }
  const caddyfilePath = args.caddyfile ?? "Caddyfile.kiwi";
  try {
    const report = await runMerchantSetupPublic({
      domain: normalized,
      port,
      caddyfilePath,
      merchantAgentId: profile.agent_id,
      profilePath: args.profile,
      checkNow: args.check,
    });
    process.stdout.write(`merchant ${report.merchantAgentId} · 端口 ${report.port} · 域名 ${report.domain}\n`);
    process.stdout.write(`公网 IP：${report.publicIp ?? "（未能自动检测，请手动确认）"}\n`);
    const dnsMsg: Record<"ok" | "mismatch" | "unresolved" | "skipped", string> = {
      ok: `DNS 已指向本机（${report.dns.resolved}）`,
      mismatch: `DNS 解析到 ${report.dns.resolved}，与公网 IP ${report.dns.expected} 不一致——请到域名服务商把 ${report.domain} 的 A 记录指向 ${report.dns.expected}`,
      unresolved: `域名 ${report.domain} 当前无法解析——请先到域名服务商添加 A 记录指向服务器公网 IP`,
      skipped: `无法对比 DNS（未检测到公网 IP），请手动确认 ${report.domain} 的 A 记录指向本机`,
    };
    process.stdout.write(`DNS：${dnsMsg[report.dns.status]}\n`);
    process.stdout.write(`已写入 ${report.caddyfilePath}：\n${report.caddyfile}`);
    for (const line of report.instructions) process.stdout.write(`${line}\n`);
    if (report.check !== null) {
      const status = report.check.httpStatus;
      process.stdout.write(
        `\n--check：${status === 200 ? "✓" : status === null ? "✗ 无法连接" : `✗ HTTP ${status}`} ${report.check.url}\n`,
      );
    }
    return EXIT.OK;
  } catch (err) {
    if (err instanceof SetupPublicError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.CONFIG;
    }
    throw err;
  }
}

/**
 * `kiwi merchant up`（D3）——一条命令上线：setup-public（生成 Caddyfile）→ 起 Caddy
 * 反代（子进程）→ 起 A2A 节点 → 退出时清理 Caddy。把第 4 步三命令合成一个。
 */
async function cmdMerchantUp(args: ParsedArgs): Promise<number> {
  const profile = requireProfileOrDefault(args);
  if (profile.role !== "merchant") {
    process.stderr.write("kiwi merchant up 需要 merchant profile（role: merchant）\n");
    return EXIT.CONFIG;
  }
  loadMerchantCredentials(); // 加载 init 写入的 credentials.env（KIWI_MERCHANT_TOKEN）

  // ── 域名 / 端口 / Caddyfile（profile 兜底）──
  const domain =
    args.domain ?? profile.merchant_public?.public_url ?? extractPublicDomain(process.env.KIWI_A2A_PUBLIC_URL) ?? "";
  if (domain === "") {
    process.stderr.write("需要公网域名——先 `kiwi merchant init` 填公网域名，或 --domain <域名>\n");
    return EXIT.CONFIG;
  }
  const port = args.port ?? profile.merchant_public?.a2a_port ?? (Number(process.env.KIWI_A2A_PORT ?? "") || 9000);
  const caddyfilePath = args.caddyfile ?? "Caddyfile.kiwi";

  // ── setup-public：检测 IP / DNS 检查 / 生成 Caddyfile（幂等）──
  await runMerchantSetupPublic({
    domain,
    port,
    caddyfilePath,
    merchantAgentId: profile.agent_id,
    profilePath: args.profile,
  });
  process.stdout.write(`[merchant up] 域名 ${domain} · 端口 ${port} · Caddyfile ${caddyfilePath}\n`);

  // ── 检查 Caddy 是否安装（fail-closed）──
  const caddyOk = spawnSync("caddy", ["version"], { stdio: "ignore" }).status === 0;
  if (!caddyOk) {
    process.stderr.write(
      "未检测到 Caddy（反代 + TLS）。请先安装：`brew install caddy`（或 https://caddyserver.com/download），然后重试。\n",
    );
    return EXIT.CONFIG;
  }

  // ── 起 Caddy 反代（子进程，日志透传）──
  const caddy = spawn("caddy", ["run", "--config", caddyfilePath], { stdio: "inherit" });

  // ── 起 A2A 节点（与 merchant start --no-chat 同一路径）──
  const catalog = args.catalog ?? profile.merchant_public?.catalog_url ?? process.env.KIWI_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const merchantToken = process.env.KIWI_MERCHANT_TOKEN || "";
  const serveDataDir = resolveServeDataDir(args.dataDir, profile.agent_id);
  let node: A2aNodeHandle | null = await startA2aNode({
    profile,
    catalog,
    preferredPort: port,
    dataDir: serveDataDir,
    ...(domain ? { publicBaseUrl: `https://${domain}` } : {}),
    ...(merchantToken ? { ownerToken: merchantToken } : {}),
    ownerTokenSecret: process.env.KIWI_CATALOG_OWNER_TOKEN_SECRET,
  });
  process.stdout.write(
    `[merchant up] A2A server: ${node.agentCardUrl}（local ${node.url}）· catalog: ${node.catalogAgentId ?? "?"}\n`,
  );
  process.stdout.write("[merchant up] 已上线 — Ctrl+C to stop（会同时停掉 Caddy 与节点）\n");

  const shutdown = async (): Promise<void> => {
    await node?.stop().catch(() => undefined);
    node = null;
    caddy.kill(); // SIGTERM → Caddy 优雅退出
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<never>(() => {});
  return EXIT.OK;
}

/**
 * `kiwi setup-hermes`（买家侧）——一键把 Kiwi 买家连接器接入 Hermes：
 * 配置 kiwi-buyer-mcp MCP server + 安装 kiwi-buyer skill。之后 Hermes 重启
 * 即可调用 9 个采购工具。等价于手动执行：
 *   hermes mcp add kiwi-buyer-mcp --command node --args <cli> mcp serve ...
 *   hermes skills install <SKILL.md URL>
 */
async function cmdSetupHermes(): Promise<number> {
  // 1. 检查 Hermes CLI
  const hermesOk = spawnSync("hermes", ["--version"], { stdio: "ignore" }).status === 0;
  if (!hermesOk) {
    process.stderr.write("未检测到 Hermes CLI（hermes）——请先安装 Hermes，再运行本命令。\n");
    return EXIT.CONFIG;
  }

  // 2. 本机 kiwi cli 路径（dist/cli.js）、principal、db 路径、skill 落盘路径
  const cliPath = fileURLToPath(import.meta.url);
  let username = "";
  try {
    username = userInfo().username;
  } catch {
    username = process.env.USER ?? "user";
  }
  const dbPath = path.join(homedir(), ".kiwi", "buyer.sqlite");
  const skillUrl = "https://raw.githubusercontent.com/harrylabsj/kiwi/main/skills/kiwi-buyer/SKILL.md";
  const bundledSkillPath = fileURLToPath(new URL("../skills/kiwi-buyer/SKILL.md", import.meta.url));
  const skillPath = path.join(homedir(), ".hermes", "skills", "kiwi-buyer", "SKILL.md");
  const configured: string[] = [];
  const already: string[] = [];

  // 3. MCP server：已存在则跳过，否则添加（避免 overwrite 交互提示）
  const mcpList = spawnSync("hermes", ["mcp", "list"], { encoding: "utf-8" });
  const mcpExists = (mcpList.stdout ?? "").includes("kiwi-buyer-mcp");
  if (mcpExists) {
    already.push("MCP server kiwi-buyer-mcp");
  } else {
    process.stdout.write("[setup-hermes] 配置 kiwi-buyer-mcp MCP server ...\n");
    const mcp = spawnSync(
      "hermes",
      [
        "mcp",
        "add",
        "kiwi-buyer-mcp",
        "--command",
        "node",
        "--args",
        cliPath,
        "mcp",
        "serve",
        "--db",
        dbPath,
        "--principal",
        `hermes:${username}`,
        "--agent",
        "buyer-agent:hermes",
      ],
      { stdio: "inherit" },
    );
    if (mcp.status !== 0) {
      process.stderr.write(`hermes mcp add 失败（退出码 ${mcp.status ?? "?"}）\n`);
      return EXIT.CONFIG;
    }
    configured.push("MCP server kiwi-buyer-mcp");
  }

  // 4. kiwi-buyer skill：优先使用 npm 包内置版本，避免依赖网络；否则从公共 URL 安装
  if (existsSync(skillPath)) {
    already.push("skill kiwi-buyer");
  } else {
    process.stdout.write("[setup-hermes] 安装 kiwi-buyer skill ...\n");
    if (existsSync(bundledSkillPath)) {
      process.stdout.write("[setup-hermes] 使用 npm 包内置 skill ...\n");
      try {
        mkdirSync(path.dirname(skillPath), { recursive: true, mode: 0o700 });
        copyFileSync(bundledSkillPath, skillPath);
        chmodSync(skillPath, 0o600);
      } catch (err) {
        process.stderr.write(`安装 kiwi-buyer skill 失败：${err instanceof Error ? err.message : String(err)}\n`);
        return EXIT.CONFIG;
      }
    } else {
      const skill = spawnSync("hermes", ["skills", "install", skillUrl, "--yes"], { stdio: "inherit" });
      if (skill.status !== 0 || !existsSync(skillPath)) {
        // 兜底：直接 fetch SKILL.md 写入 ~/.hermes/skills/kiwi-buyer/（Hermes skills 为 local 存储）
        process.stdout.write("[setup-hermes] hermes skills install 不可用，改用直接写入 ...\n");
        try {
          const res = await fetch(skillUrl, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const content = await res.text();
          mkdirSync(path.dirname(skillPath), { recursive: true, mode: 0o700 });
          writeFileSync(skillPath, content, { mode: 0o600 });
        } catch (err) {
          process.stderr.write(`安装 kiwi-buyer skill 失败：${err instanceof Error ? err.message : String(err)}\n`);
          return EXIT.CONFIG;
        }
      }
    }
    configured.push("skill kiwi-buyer");
  }

  // 5. 报告
  for (const item of already) process.stdout.write(`  ✓ ${item} 已配置，跳过\n`);
  for (const item of configured) process.stdout.write(`  ✓ ${item} 已配置\n`);
  process.stdout.write(
    "✓ Kiwi 已接入 Hermes。请重启 Hermes（或开新会话），然后直接说出采购需求（如「帮我买 200 个 USB-C 扩展坞，7 天内到」）。\n",
  );
  return EXIT.OK;
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
  if (hasHelp && firstArg === "weixin") {
    process.stdout.write(weixinUsage());
    return EXIT.OK;
  }
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
  // `kiwi mcp serve <raw flags>`：MCP server 有自己的 flag 集（--db/--principal/
  // --agent/--session/--policy），不经过全局 parseArgs（会拒绝未知参数）。
  if (argv[0] === "mcp" && argv[1] === "serve") {
    return await runMcpServe(argv.slice(2));
  }
  // `kiwi buyer-api serve`：同样走独立 flag 集（--port/--host/--marketplace-url 等）。
  if (argv[0] === "buyer-api" && argv[1] === "serve") {
    return await runHttpServe(argv.slice(2));
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
    if (cmd === "setup-hermes") return await cmdSetupHermes();
    if (cmd === "network") return await routeNetwork(sub);
    if (cmd === "demo") return await cmdDemo(args);
    if (cmd === "doctor") {
      // 无 --profile → 三组件聚合健康（D0）；有 → 既有 profile doctor
      return args.profile !== undefined ? await cmdDoctor(args) : await cmdProductDoctor();
    }
    if (cmd === "agent" && sub === "run") return await cmdAgentRun(args);
    if (cmd === "agent" && sub === "serve") return await cmdAgentServe(args);  // 旧命令别名保留
    if (cmd === "tui") return await cmdTui(args);
    if (cmd === "chat") return await cmdChat(args);
    if (cmd === "weixin") {
      return await cmdWeixin({
        profile: args.profile,
        dataDir: args.dataDir,
        allow: args.weixinAllow,
        relogin: args.relogin,
        // 审查 P2-L：weixin 命令 A2A 节点默认关（headless 控制面收窄攻击面），
        // 仅 --a2a 显式开启（--no-a2a 仍可覆盖）。裸 kiwi/chat 命令的
        // A2A 默认开不受影响（各自按 noA2a 判断）。
        a2a: args.a2aExplicit && !args.noA2a,
        port: args.port,
        qrScale: args.qrScale,
        noQr: args.noQr,
        catalog: args.catalog,
      });
    }
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
    if (cmd === "mcp") {
      // `kiwi mcp serve` —— kiwi-buyer-mcp stdio server（战略 v2.5 §6.1）。
      if (sub === "serve") return await runMcpServe(args.command.slice(2));
      process.stderr.write("usage: kiwi mcp serve [--db <file>] [--principal <id>] [--agent <id>] [--session <id>] [--policy <file>] [--catalog-url <url>] [--marketplace-url <url>] [--a2a-*]\n");
      return EXIT.CONFIG;
    }
    if (cmd === "buyer-api") {
      // `kiwi buyer-api serve` —— Buyer Core 的 HTTP 包装（§6.3 单核心多包装）。
      if (sub === "serve") return await runHttpServe(args.command.slice(2));
      process.stderr.write("usage: kiwi buyer-api serve [--db <file>] [--port <port>] [--host <host>] [--marketplace-url <url>] [--buyer-bootstrap-token <token>]\n");
      return EXIT.CONFIG;
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
    if (cmd === "catalog") {
      // `kiwi catalog serve` —— 前台启动独立 kiwi-catalog 服务（CURRENT-DOCS）。
      const sub = args.command[1] ?? "";
      if (sub === "serve") {
        const result = catalogServe({
          db: args.catalogDb,
          host: args.catalogHost,
          port: args.port,
        });
        if (!result.ok) {
          process.stderr.write(`${result.error ?? "kiwi-catalog 启动失败"}\n`);
          return EXIT.CONFIG;
        }
        return EXIT.OK;
      }
      process.stderr.write("usage: kiwi catalog serve [--db <file>] [--host <host>] [--port <port>]\n");
      return EXIT.CONFIG;
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
      // 审查 K-L18：配置/环境类错误（kind=config）→ EXIT.CONFIG(2)；运行时/
      // 操作类（transient）→ EXIT.TRANSIENT(10)。此前一律 TRANSIENT，退出码
      // 语义混淆（脚本按退出码判断"配置错"会误判为"瞬时故障可重试"）。
      return err.kind === "config" ? EXIT.CONFIG : EXIT.TRANSIENT;
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
