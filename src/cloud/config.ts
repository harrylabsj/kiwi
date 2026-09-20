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
 * 云端 Runtime 配置（设计 v0.1.2 §8.1）：从平台注入的环境变量解析并**强校验**。
 *
 * 三条硬规则（对应 M1 验收）：
 *   - 端口必须显式来自平台，占用即失败、绝不换端口（T013）；
 *   - 持久状态目录必须显式给出、非临时、且不落在制品内（T014）；
 *   - 公网广告地址下禁止 none/loopback 这类弱认证（T015）。
 *
 * 本模块只回答"能不能启动"；"是否就绪"见 readiness.ts。校验失败一律抛
 * CloudConfigError（带稳定 reason code），调用方据此非零退出并打印，不静默降级。
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 配置错误：code 是稳定的机器可读原因，message 面向操作者（不含凭据值）。 */
export class CloudConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CloudConfigError";
    this.code = code;
  }
}

/** A2A 入站认证模式：弱模式（none/loopback）在云端被拒绝。 */
export type CloudA2aAuth =
  | { mode: "signature" }
  | { mode: "bearer"; tokenEnv: string };

export interface CloudRuntimeConfig {
  /** 平台指定端口（云平台注入 PORT）。 */
  port: number;
  /** 监听地址：平台把公网流量转进来，缺省 0.0.0.0。 */
  bindHost: string;
  /** 公网 origin（来自 publicConfig.endpoint；https，不含路径）。 */
  publicOrigin: string;
  /** 权威状态目录：必须在制品之外（deploy 会覆盖制品内同名文件）。 */
  dataDir: string;
  /** 商家 profile 文件路径。 */
  profilePath: string;
  /** 实际使用的配置文件路径（缺省 <artifactRoot>/cloud.config.json）。 */
  configFile: string;
  /** 商家上传的商品表（设计 §10.1 的"商家上传商品表"路径）；缺省回退 HTTP 商品源。 */
  productsFile?: string;
  /** 就绪检查用的探针 SKU（授权测试商品）。 */
  readinessSku?: string;
  /** 制品根目录（缺省 process.cwd()）：用于数据目录落位校验。 */
  artifactRoot: string;
  /** A2A 入站认证（弱模式已被拒绝）。 */
  a2aAuth: CloudA2aAuth;
  /** readyz 单检查超时（毫秒）：探针不得挂起。 */
  readinessTimeoutMs: number;
}

/** 制品随包发布的目录：权威状态目录不得落在其中（会被 deploy 覆盖）。 */
const SHIPPED_ARTIFACT_DIRS = ["dist", "contracts", "skills", "node_modules"] as const;

function readEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) {
    throw new CloudConfigError(
      "PORT_REQUIRED",
      "缺少平台端口：云端模式必须显式提供 PORT（平台注入），不自动回退随机端口",
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new CloudConfigError("PORT_INVALID", `PORT 必须是十进制整数（收到 ${raw}）`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new CloudConfigError("PORT_INVALID", `PORT 超出范围 1..65535（收到 ${port}）`);
  }
  return port;
}

function isLoopbackOrigin(origin: URL): boolean {
  return (
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "localhost" ||
    origin.hostname === "::1" ||
    origin.hostname === "[::1]"
  );
}

/** 解析并校验公网 origin：https（loopback 本地自检允许 http），不得带路径/查询。 */
function parsePublicOrigin(raw: string | undefined): string {
  if (raw === undefined) {
    throw new CloudConfigError(
      "PUBLIC_ORIGIN_REQUIRED",
      "缺少公网地址：必须提供 publicConfig.endpoint 对应的 origin（https://host）",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudConfigError("PUBLIC_ORIGIN_INVALID", `公网地址不是合法 URL：${raw}`);
  }
  const loopback = isLoopbackOrigin(url);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new CloudConfigError(
      "PUBLIC_ORIGIN_INSECURE",
      `公网地址必须是 https（仅 loopback 本地自检允许 http）：${raw}`,
    );
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new CloudConfigError(
      "PUBLIC_ORIGIN_HAS_PATH",
      `公网地址只接受 origin（不含路径/查询）：${raw}`,
    );
  }
  return url.origin;
}

/**
 * 解析 A2A 入站认证：只接受 signature / bearer:<ENV>。
 * none 与 loopback 在云端是弱认证——公网可达时二者等价于无认证（T015）。
 */
function parseA2aAuth(env: Record<string, string | undefined>, raw: string | undefined): CloudA2aAuth {
  if (raw === undefined) {
    throw new CloudConfigError(
      "A2A_AUTH_REQUIRED",
      "云端模式必须显式配置 KIWI_CLOUD_A2A_AUTH=signature 或 bearer:<TOKEN_ENV>（禁止缺省 loopback）",
    );
  }
  if (raw === "signature") return { mode: "signature" };
  if (raw.startsWith("bearer:")) {
    const tokenEnv = raw.slice("bearer:".length).trim();
    if (tokenEnv === "") {
      throw new CloudConfigError(
        "A2A_AUTH_INVALID",
        "bearer 模式必须给出承载令牌的环境变量名：bearer:<TOKEN_ENV>",
      );
    }
    const token = readEnv(env, tokenEnv);
    if (token === undefined) {
      throw new CloudConfigError(
        "A2A_AUTH_TOKEN_MISSING",
        `bearer 令牌环境变量 ${tokenEnv} 未设置或为空`,
      );
    }
    return { mode: "bearer", tokenEnv };
  }
  throw new CloudConfigError(
    "A2A_AUTH_WEAK",
    `云端拒绝弱认证模式 ${raw}：公网可达时必须使用 signature 或 bearer:<TOKEN_ENV>`,
  );
}

/** 权威状态目录落位校验：绝对路径、非临时目录、不落在制品随包目录内。 */
function assertDataDirPlacement(dataDir: string, artifactRoot: string): void {
  if (!path.isAbsolute(dataDir)) {
    throw new CloudConfigError("DATA_DIR_NOT_ABSOLUTE", `状态目录必须是绝对路径：${dataDir}`);
  }
  const resolved = path.resolve(dataDir);
  const root = path.resolve(artifactRoot);
  const tmp = path.resolve(tmpdir());
  if (resolved === tmp || resolved.startsWith(tmp + path.sep)) {
    throw new CloudConfigError(
      "DATA_DIR_EPHEMERAL",
      `状态目录不得位于临时目录（重启即丢）：${resolved}`,
    );
  }
  if (resolved === root) {
    throw new CloudConfigError("DATA_DIR_IS_ARTIFACT_ROOT", "状态目录不得等于制品根目录");
  }
  const rel = path.relative(root, resolved);
  if (rel !== "" && !rel.startsWith(".." + path.sep) && rel !== "..") {
    const first = rel.split(path.sep)[0] ?? "";
    if ((SHIPPED_ARTIFACT_DIRS as readonly string[]).includes(first)) {
      throw new CloudConfigError(
        "DATA_DIR_INSIDE_SHIPPED_DIR",
        `状态目录落在随包目录 ${first}/ 内，deploy 会用制品同名文件覆盖它：${resolved}`,
      );
    }
  }
}

export interface LoadCloudConfigOptions {
  /** 制品根目录（缺省 process.cwd()；平台实测 cwd=/workspace）。 */
  artifactRoot?: string;
  /**
   * 配置文件路径（缺省 `<artifactRoot>/cloud.config.json`；不存在则跳过）。
   * 平台只注入 PORT，其余非敏感配置随部署包提供；**环境变量优先于文件**。
   */
  configFile?: string;
}

/** 配置文件内容（全部非敏感；凭据一律拒绝）。 */
export interface CloudConfigFile {
  public_origin?: string;
  data_dir?: string;
  profile?: string;
  products_file?: string;
  readiness_sku?: string;
  bind_host?: string;
  readyz_timeout_ms?: number;
  a2a_auth?: { mode?: string } | string;
}

/** 读配置文件（不存在返回 undefined；内容非法即抛错，不静默忽略）。 */
export function readCloudConfigFile(file: string): CloudConfigFile | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new CloudConfigError(
      "CONFIG_FILE_INVALID",
      `配置文件不是合法 JSON：${file}（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CloudConfigError("CONFIG_FILE_INVALID", `配置文件必须是 JSON 对象：${file}`);
  }
  return parsed as CloudConfigFile;
}

/**
 * 文件里的 A2A 认证：**只接受 signature**。
 * bearer 需要令牌，令牌不得进部署包（密钥不进制品），因此 bearer 只能经环境变量提供。
 */
function parseA2aAuthFromFile(file: CloudConfigFile, source: string): string | undefined {
  const raw = file.a2a_auth;
  if (raw === undefined) return undefined;
  const mode = typeof raw === "string" ? raw : raw.mode;
  if (mode === undefined) return undefined;
  if (mode === "signature") return "signature";
  throw new CloudConfigError(
    "CONFIG_FILE_AUTH_UNSUPPORTED",
    `配置文件（${source}）只能声明 a2a_auth.mode="signature"；` +
      `bearer 令牌必须经环境变量提供（密钥不进部署包）`,
  );
}

/**
 * 装载云端配置：**环境变量 > 配置文件 > 缺省值**。
 * 任何缺失/不安全项都抛 CloudConfigError，绝不回退到不安全缺省。
 */
export function loadCloudConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadCloudConfigOptions = {},
): CloudRuntimeConfig {
  const artifactRoot = path.resolve(
    options.artifactRoot ?? readEnv(env, "KIWI_CLOUD_ARTIFACT_ROOT") ?? process.cwd(),
  );
  const configFile = path.resolve(
    options.configFile ?? readEnv(env, "KIWI_CLOUD_CONFIG") ?? path.join(artifactRoot, "cloud.config.json"),
  );
  const file = readCloudConfigFile(configFile) ?? {};
  const fromFile = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === "" ? undefined : value.trim();

  const port = parsePort(readEnv(env, "KIWI_CLOUD_PORT") ?? readEnv(env, "PORT"));
  const publicOrigin = parsePublicOrigin(
    readEnv(env, "KIWI_CLOUD_PUBLIC_ORIGIN") ?? fromFile(file.public_origin),
  );
  const bindHost = readEnv(env, "KIWI_CLOUD_BIND_HOST") ?? fromFile(file.bind_host) ?? "0.0.0.0";
  const dataDir = readEnv(env, "KIWI_CLOUD_DATA_DIR") ?? fromFile(file.data_dir);
  if (dataDir === undefined) {
    throw new CloudConfigError(
      "DATA_DIR_REQUIRED",
      "缺少权威状态目录：必须显式提供 KIWI_CLOUD_DATA_DIR 或配置文件的 data_dir（禁止退回临时目录）",
    );
  }
  assertDataDirPlacement(dataDir, artifactRoot);

  const profilePath = readEnv(env, "KIWI_CLOUD_PROFILE") ?? fromFile(file.profile);
  if (profilePath === undefined) {
    throw new CloudConfigError(
      "PROFILE_REQUIRED",
      "缺少商家 profile：必须显式提供 KIWI_CLOUD_PROFILE 或配置文件的 profile（云端不从交互式 CLI 推导）",
    );
  }
  const a2aAuthRaw =
    readEnv(env, "KIWI_CLOUD_A2A_AUTH") ?? parseA2aAuthFromFile(file, configFile);
  const a2aAuth = parseA2aAuth(env, a2aAuthRaw);
  const timeoutRaw =
    readEnv(env, "KIWI_CLOUD_READYZ_TIMEOUT_MS") ??
    (file.readyz_timeout_ms !== undefined ? String(file.readyz_timeout_ms) : undefined);
  const readinessTimeoutMs = timeoutRaw === undefined ? 2000 : Number(timeoutRaw);
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    throw new CloudConfigError(
      "READYZ_TIMEOUT_INVALID",
      `readyz 超时必须是正数（收到 ${timeoutRaw}）`,
    );
  }

  const productsFile = readEnv(env, "KIWI_CLOUD_PRODUCTS_FILE") ?? fromFile(file.products_file);
  const readinessSku = readEnv(env, "KIWI_CLOUD_READINESS_SKU") ?? fromFile(file.readiness_sku);

  return {
    port,
    bindHost,
    publicOrigin,
    dataDir: path.resolve(dataDir),
    profilePath: path.resolve(profilePath),
    artifactRoot,
    configFile,
    ...(productsFile !== undefined ? { productsFile: path.resolve(productsFile) } : {}),
    ...(readinessSku !== undefined ? { readinessSku } : {}),
    a2aAuth,
    readinessTimeoutMs: Math.floor(readinessTimeoutMs),
  };
}

/** 供启动日志使用的脱敏摘要（不含令牌、密钥与账号标识）。 */
export function describeCloudConfig(config: CloudRuntimeConfig): Record<string, string | number> {
  return {
    port: config.port,
    bindHost: config.bindHost,
    publicOrigin: config.publicOrigin,
    dataDir: config.dataDir,
    a2aAuth: config.a2aAuth.mode === "signature" ? "signature" : `bearer(${config.a2aAuth.tokenEnv})`,
  };
}

/**
 * 生产禁演示价回退（设计 §10.2 / §15.3）：profile 打开演示价兜底即拒绝启动。
 * 演示价会让"商品源失联"看起来像有报价——属于权威状态失真，不做运行时警告了事。
 */
export function assertNoDemoPriceFallback(profile: { commerce?: { allow_demo_price_fallback?: boolean } }): void {
  if (profile.commerce?.allow_demo_price_fallback === true) {
    throw new CloudConfigError(
      "DEMO_PRICE_FALLBACK_FORBIDDEN",
      "云端生产禁止演示价回退（commerce.allow_demo_price_fallback=true）：请改用真实商品源",
    );
  }
}
