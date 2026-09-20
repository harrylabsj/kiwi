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
 * 云端 Runtime 启动装配（设计 v0.1.2 §8.1）。
 *
 * 启动顺序（缺任一项即拒绝启动，不静默降级）：
 *   校验平台契约与配置 → 校验商家绑定与状态目录 → 装配商家面（审批/策略/商品/
 *   工具面）→ 构造 A2A 核心（Ledger/幂等/merchant handler）→ 挂载单端口路由 →
 *   **严格**按平台端口监听（占用即失败）→ 自检并输出脱敏启动行。
 *
 * 与自托管形态的差异（全部是云端硬约束）：
 *   - 不启动交互式 CLI、不启动对话内核；
 *   - 不调用 `startA2aNode` 的 catalog 自动注册分支（目录注册由 M4 Enrollment 编排）；
 *   - 端口占用**不换端口**（T013）；
 *   - 权威状态目录必须显式给出且不在制品内（T014）；
 *   - 公网广告地址下弱认证在配置层已被拒绝（T015）。
 */

import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createA2aNodeCore, createA2aAuthVerifier } from "../a2a/node.js";
import { loadOrCreateA2aSigningIdentity } from "../a2a/signing-key.js";
import { loadProfile, ProfileError } from "../config/profile.js";
import {
  assembleMerchantRuntime,
  MerchantAssemblyError,
  type MerchantRuntimeAssembly,
} from "../mcp/merchant-runtime-assembly.js";
import {
  createMerchantHttpHandler,
  DEFAULT_MERCHANT_MCP_PATH as MCP_PATH,
} from "../mcp/merchant-server.js";
import { PRODUCT_VERSION } from "../product-cli.js";
import {
  CloudConfigError,
  assertNoDemoPriceFallback,
  describeCloudConfig,
  loadCloudConfig,
  type CloudRuntimeConfig,
} from "./config.js";
import { createCloudRouter } from "./http-router.js";
import { createFileProductSource, type CloudProductSourceHandle } from "./product-source.js";
import { runReadiness, type ReadinessCheckResult, type ReadinessReport } from "./readiness.js";

/** 云端 A2A 端点路径（设计 §8.2；与自托管根路径不同，便于同端口分发）。 */
export const CLOUD_A2A_PATH = "/a2a";

export interface CloudBootstrapOptions {
  env?: Record<string, string | undefined>;
  artifactRoot?: string;
  log?: (line: string) => void;
}

export interface CloudInstance {
  config: CloudRuntimeConfig;
  /** 已监听的单端口 http server。 */
  server: Server;
  /** 就绪检查入口（/readyz 与自检共用）。 */
  readiness: () => Promise<ReadinessReport>;
  close: () => Promise<void>;
}

/** 启动失败：code 稳定可判（配置错误/装配错误/端口占用等）。 */
export class CloudStartupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CloudStartupError";
    this.code = code;
  }
}

/**
 * 权威状态目录防覆盖（M0 事实 #2）：deploy 是目录上传覆盖同名文件，若状态目录
 * 里出现制品文件（package.json），说明制品被发布到了状态目录之上——权威状态
 * 已在不可知状态，必须拒绝启动而不是继续写。
 */
function assertDataDirNotClobbered(dataDir: string): void {
  const markers = ["package.json"];
  for (const marker of markers) {
    if (existsSync(path.join(dataDir, marker))) {
      throw new CloudStartupError(
        "DATA_DIR_CLOBBERED",
        `状态目录 ${dataDir} 内出现制品文件 ${marker}：制品可能被发布到状态目录之上，` +
          "权威状态不可信，拒绝启动",
      );
    }
  }
}

/** 权威存储可读写探针：写一行、读回、回滚（不留痕，也不依赖表结构）。 */
function probeAuthoritativeStorage(dataDir: string): ReadinessCheckResult {
  const dbPath = path.join(dataDir, "state.sqlite");
  if (!existsSync(dbPath)) {
    return { ok: false, code: "STORAGE_MISSING" };
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("BEGIN IMMEDIATE");
    db.exec("CREATE TABLE IF NOT EXISTS readyz_probe (id INTEGER PRIMARY KEY, at TEXT NOT NULL)");
    db.prepare("INSERT INTO readyz_probe (at) VALUES (?)").run(new Date().toISOString());
    const row = db.prepare("SELECT COUNT(*) AS count FROM readyz_probe").get() as
      | { count?: number }
      | undefined;
    db.exec("ROLLBACK");
    return (row?.count ?? 0) > 0 ? { ok: true } : { ok: false, code: "STORAGE_READBACK_FAILED" };
  } catch {
    // 只回稳定码：细节（路径、锁持有者）留在启动日志，不对外暴露。
    return { ok: false, code: "STORAGE_WRITE_FAILED" };
  } finally {
    try {
      db?.close();
    } catch {
      // 关闭失败不改变结论
    }
  }
}

/**
 * 启动云端 Runtime。任何拒绝都抛 CloudStartupError / CloudConfigError，
 * 由入口非零退出并打印（绝不带着错误配置对外服务）。
 */
export async function bootstrapCloudRuntime(
  options: CloudBootstrapOptions = {},
): Promise<CloudInstance> {
  const log =
    options.log ??
    ((line: string): void => {
      process.stdout.write(line);
    });
  const config = loadCloudConfig(options.env ?? process.env, {
    ...(options.artifactRoot !== undefined ? { artifactRoot: options.artifactRoot } : {}),
  });

  // 1) 商家 profile：云端只接受 merchant 角色（buyer 侧由 Catalog/Buyer 通道承载）。
  let profile;
  try {
    profile = loadProfile(config.profilePath);
  } catch (err) {
    if (err instanceof ProfileError) {
      throw new CloudStartupError("PROFILE_LOAD_FAILED", err.message);
    }
    throw err;
  }
  if (profile.role !== "merchant") {
    throw new CloudStartupError(
      "PROFILE_NOT_MERCHANT",
      `云端 Runtime 需要 merchant profile（收到 role=${profile.role}）`,
    );
  }
  // 生产禁演示价回退（设计 §10.2）：演示价会让"商品源失联"看起来像有报价。
  assertNoDemoPriceFallback(profile);
  assertDataDirNotClobbered(config.dataDir);

  // 2) 商家面装配（审批/策略/商品/RFQ/工具面）；认证走 OAuth（issuer = 公网 origin）。
  let assembly: MerchantRuntimeAssembly;
  try {
    assembly = await assembleMerchantRuntime({
      profile,
      dataDir: config.dataDir,
      host: config.bindHost,
      port: config.port,
      mcpPath: MCP_PATH,
      authMode: "oauth",
      issuer: config.publicOrigin,
      log,
    });
  } catch (err) {
    if (err instanceof MerchantAssemblyError) {
      throw new CloudStartupError(`ASSEMBLY_${err.code}`, err.message);
    }
    throw err;
  }

  // 3) A2A 核心：签名身份 + 入站认证（弱模式已在配置层拒绝）。
  const signingKeyDir = config.dataDir;
  const signingIdentity =
    config.a2aAuth.mode === "signature"
      ? loadOrCreateA2aSigningIdentity(signingKeyDir, config.publicOrigin)
      : undefined;
  const bearerToken =
    config.a2aAuth.mode === "bearer"
      ? (options.env ?? process.env)[config.a2aAuth.tokenEnv]
      : undefined;
  const authVerifier = createA2aAuthVerifier({
    mode: config.a2aAuth.mode,
    ...(bearerToken !== undefined ? { bearerToken } : {}),
    signingKeyDir,
    signingKeyId: signingIdentity?.keyid ?? config.publicOrigin,
    advertisedBase: config.publicOrigin,
    // 云端必须按声明 origin 重建目标 URI：平台网关会改写入站 Host（M0 事实 #4）。
    authoritySource: "declared",
  });
  // 商品源：配置文件给了商品表就用"商家上传商品表"路径（设计 §10.1），
  // 否则沿用 HTTP 商品源（shopping-cli 开放层）。两条路径都不含演示价回退。
  const fileProductSource: CloudProductSourceHandle | undefined =
    config.productsFile !== undefined
      ? createFileProductSource({ file: config.productsFile, merchantId: profile.owner_id })
      : undefined;
  const core = createA2aNodeCore({
    profile,
    advertisedBase: config.publicOrigin,
    a2aPath: CLOUD_A2A_PATH,
    dataDir: config.dataDir,
    authVerifier,
    ...(signingIdentity !== undefined ? { signingIdentity } : {}),
    ...(fileProductSource !== undefined ? { productSource: fileProductSource.source } : {}),
  });

  // 4) 就绪检查（无敏感值；stale 商品/未配置探针 SKU 都算未就绪，不冒充可用）。
  const probeSku = config.readinessSku;
  const readiness = async (): Promise<ReadinessReport> =>
    await runReadiness({
      timeoutMs: config.readinessTimeoutMs,
      identity: () => {
        if (config.a2aAuth.mode === "signature") {
          return signingIdentity !== undefined
            ? { ok: true }
            : { ok: false, code: "IDENTITY_SIGNING_KEY_MISSING" };
        }
        return bearerToken !== undefined
          ? { ok: true }
          : { ok: false, code: "IDENTITY_BEARER_TOKEN_MISSING" };
      },
      storage: () => probeAuthoritativeStorage(config.dataDir),
      products: async () => {
        if (core.productSource === undefined) return { ok: false, code: "PRODUCTS_SOURCE_ABSENT" };
        if (probeSku === undefined || probeSku === "") {
          // 未配置探针 SKU：M1 必须用授权真实测试商品，不能凭"进程活着"判就绪。
          return { ok: false, code: "PRODUCTS_PROBE_SKU_UNSET" };
        }
        if (fileProductSource !== undefined) {
          // 文件式商品源：只回可用性原因码（不含价格）。
          const check = fileProductSource.describeSku(probeSku);
          return check.available ? { ok: true } : { ok: false, code: check.code ?? "PRODUCTS_UNAVAILABLE" };
        }
        try {
          const product = await core.productSource.getProduct(probeSku);
          return product !== undefined ? { ok: true } : { ok: false, code: "PRODUCTS_NOT_FOUND" };
        } catch {
          return { ok: false, code: "PRODUCTS_UNREACHABLE" };
        }
      },
      policy: () => {
        const current = assembly.policy();
        return current.digest !== "" ? { ok: true } : { ok: false, code: "POLICY_EMPTY" };
      },
    });

  // 5) 单端口路由：A2A 面 / 商家面 / 探针，各自鉴权边界不变。
  const merchantHandler = createMerchantHttpHandler(assembly.serverOptions);
  const router = createCloudRouter({
    a2aHandler: core.server.handler(),
    merchantHandler: merchantHandler.handler,
    readiness,
    a2aPaths: [CLOUD_A2A_PATH],
    version: PRODUCT_VERSION,
  });
  const server = createServer(router);
  server.on("clientError", () => {
    // 畸形客户端流量（中止的 socket 等）不得让服务崩溃。
  });

  // 6) 严格监听：端口被占用即失败，绝不换端口（T013）。
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: { code?: string }): void => {
        reject(
          new CloudStartupError(
            err.code === "EADDRINUSE" ? "PORT_IN_USE" : "LISTEN_FAILED",
            `监听 ${config.bindHost}:${config.port} 失败（${err.code ?? "unknown"}）：` +
              "云端不换端口——请确认端口未被占用且与平台注入值一致",
          ),
        );
      };
      server.once("error", onError);
      server.listen(config.port, config.bindHost, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  } catch (err) {
    core.close();
    await assembly.close().catch(() => undefined);
    throw err;
  }

  const summary = describeCloudConfig(config);
  log(
    `[kiwi-cloud] listening ${config.bindHost}:${config.port}` +
      `（origin=${summary.publicOrigin}，a2a=${CLOUD_A2A_PATH}，auth=${summary.a2aAuth}，` +
      `merchant=${assembly.authLabel}，version=${PRODUCT_VERSION}）\n`,
  );

  // 自检：把就绪结论写进启动日志（不含敏感值）；不就绪只告警不拒绝启动
  // （M1 允许"进程活着但未就绪"——探针语义由 /readyz 精确表达）。
  try {
    const report = await readiness();
    log(
      `[kiwi-cloud] readyz=${report.ready ? "ready" : "not-ready"}` +
        ` checks=${JSON.stringify(report.checks)}\n`,
    );
  } catch {
    log("[kiwi-cloud] readyz 自检异常（不影响启动）\n");
  }

  return {
    config,
    server,
    readiness,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await merchantHandler.close().catch(() => undefined);
      core.close();
      await assembly.close().catch(() => undefined);
    },
  };
}

/** 供入口脚本复用的错误渲染：稳定码 + 可读消息，不含凭据。 */
export function renderStartupFailure(err: unknown): string {
  if (err instanceof CloudConfigError || err instanceof CloudStartupError) {
    return `[kiwi-cloud] 启动失败（${err.code}）：${err.message}\n`;
  }
  if (err instanceof Error) return `[kiwi-cloud] 启动失败：${err.message}\n`;
  return `[kiwi-cloud] 启动失败：${String(err)}\n`;
}
