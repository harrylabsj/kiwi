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
 * 云端单端口路由器（设计 v0.1.2 §8.2）。
 *
 * 一个端口同时承载：公开 Card/发现、A2A 端点、探针与商家管理面——**路由级**
 * 鉴权隔离由各被挂载 handler 自己负责（A2A 认证、管理面会话+CSRF），本层只做
 * 路径分发，不放宽任何一处鉴权：
 *   - `/.cloud/*` 归平台数据面，业务 router **显式跳过**，绝不接管（M0 事实）；
 *   - `/healthz` 在平台上被拦截（休眠中也返回 "Pod alive"），因此业务存活
 *     另有 `/livez`：平台应答不代表应用存活（M0 事实，T059 口径）；
 *   - 未知路径返回最小 404，不回显请求内容与内部信息。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReadinessReport } from "./readiness.js";

export type CloudRequestListener = (req: IncomingMessage, res: ServerResponse) => void;

export interface CloudRouterOptions {
  /** A2A 面：Agent Card/发现 + A2A 端点（A2AServer.handler()）。 */
  a2aHandler: CloudRequestListener;
  /** 商家面：/mcp、/oauth/*、/pairing/*、/admin/*（createMerchantHttpHandler）。 */
  merchantHandler: CloudRequestListener;
  /**
   * 商家管理 API（BD 设计 §9：`/merchant/api/*`，契约 `merchant-management/1`）。
   * 必须先于 `/merchant/*` 别名接管——别名会把该前缀改写成 `/admin/api/*`
   * （管理面与审核页是两个权限面，不能混）。未提供时该前缀维持旧行为。
   */
  merchantApiHandler?: CloudRequestListener;
  /**
   * 商家工作台首页（BD §9.1 的 `/merchant/` 静态壳；不含数据，数据请求仍须
   * 认证）。精确匹配 `/merchant` 与 `/merchant/`；必须先于别名接管。
   */
  merchantHomePage?: CloudRequestListener;
  /** Buyer 关注/隐私面；只有配置了可验证 Buyer 身份解析器时才挂载。 */
  buyerHandler?: CloudRequestListener;
  /** 匿名公开 Feed；不得与 Buyer/管理认证缓存边界混用。 */
  publicFeedHandler?: CloudRequestListener;
  /** 独立顶层 WebAuthn 注册/确认页。 */
  trustedPageHandler?: CloudRequestListener;
  /** 就绪检查（每次请求重新执行，不缓存）。 */
  readiness: () => Promise<ReadinessReport>;
  /** A2A 端点路径（与 A2AServer 的 cardConfig.a2aPath 保持一致）。 */
  a2aPaths?: readonly string[];
  /** 绑定挑战（M2）；缺省时 /control/challenge 明确返回 501，不空实现。 */
  challengeHandler?: CloudRequestListener;
  /** 供 /livez 回显的版本号（非敏感）。 */
  version: string;
}

/** 商家面路径前缀（现有实现路径 + 设计 §8.2 的 /merchant/* 别名）。 */
const MERCHANT_PREFIXES = ["/mcp", "/oauth/", "/pairing/", "/admin/", "/merchant/"] as const;
const MERCHANT_WELL_KNOWN = ["/.well-known/oauth-", "/.well-known/openid-configuration"] as const;
const A2A_WELL_KNOWN = ["/.well-known/agent-card.json", "/.well-known/ucp"] as const;
const DEFAULT_A2A_PATHS = ["/a2a"] as const;

const NO_STORE = { "cache-control": "no-store" } as const;

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function startsWithAny(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p));
}

export function createCloudRouter(options: CloudRouterOptions): CloudRequestListener {
  const a2aPaths = options.a2aPaths ?? DEFAULT_A2A_PATHS;

  return (req, res) => {
    const rawUrl = req.url ?? "/";
    let url: URL;
    try {
      url = new URL(rawUrl, "http://cloud.internal");
    } catch {
      writeJson(res, 400, { error: "invalid_request_target" });
      return;
    }
    const pathname = url.pathname;

    // 1) 平台数据面：业务 router 不接管（平台在更外层处理；到此即明确 404）。
    if (pathname === "/.cloud" || pathname.startsWith("/.cloud/")) {
      writeJson(res, 404, { error: "reserved_path", message: "reserved for platform data plane" });
      return;
    }

    // 2) 探针。平台拦截 /healthz，业务存活以 /livez 为准。
    if (pathname === "/healthz") {
      writeJson(res, 200, { ok: true }, NO_STORE);
      return;
    }
    if (pathname === "/livez") {
      // T001 收口：由实际 Node 进程自证运行时版本。只回非敏感的 process.version，
      // 不依赖平台失败栈、镜像标签或部署记录推断。
      writeJson(res, 200, { ok: true, node: process.version }, NO_STORE);
      return;
    }
    if (pathname === "/readyz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeJson(res, 405, { error: "method_not_allowed" }, NO_STORE);
        return;
      }
      void options
        .readiness()
        .then((report) => {
          writeJson(res, report.ready ? 200 : 503, report, NO_STORE);
        })
        .catch(() => {
          writeJson(res, 503, { ready: false, checks: { internal: { ok: false, code: "READINESS_ERROR" } } }, NO_STORE);
        });
      return;
    }

    // 3) 绑定挑战：M1 未实现，明确 501（禁止成功空实现）。
    if (pathname === "/control/challenge") {
      if (options.challengeHandler !== undefined) {
        options.challengeHandler(req, res);
        return;
      }
      writeJson(
        res,
        501,
        { error: "not_implemented", message: "端点挑战属 M2 绑定流程，云端 M1 切片未提供" },
        NO_STORE,
      );
      return;
    }

    // 4) 商家面。/merchant/api/* 是管理契约路径（BD 设计 §9.1），必须先于
    //    /merchant/* 别名接管，否则会被改写成 /admin/api/*（§3.2 陷阱）。
    if (
      options.merchantApiHandler !== undefined &&
      (pathname === "/merchant/api" || pathname.startsWith("/merchant/api/"))
    ) {
      options.merchantApiHandler(req, res);
      return;
    }

    // 5) 商家工作台首页：/merchant 与 /merchant/（BD §9.1 静态壳；先于别名）。
    if (
      options.merchantHomePage !== undefined &&
      (pathname === "/merchant" || pathname === "/merchant/")
    ) {
      options.merchantHomePage(req, res);
      return;
    }

    if (
      options.trustedPageHandler !== undefined &&
      (pathname === "/merchant/trusted" || pathname.startsWith("/merchant/trusted/"))
    ) {
      options.trustedPageHandler(req, res);
      return;
    }

    if (
      options.buyerHandler !== undefined &&
      (pathname === "/buyer/v1" || pathname.startsWith("/buyer/v1/"))
    ) {
      options.buyerHandler(req, res);
      return;
    }

    if (
      options.publicFeedHandler !== undefined &&
      (pathname === "/public/v1" || pathname.startsWith("/public/v1/"))
    ) {
      options.publicFeedHandler(req, res);
      return;
    }

    // 6) 商家面：/merchant/* 别名映射到现有 /admin/*（设计 §8.2 路由名）。
    if (startsWithAny(pathname, MERCHANT_PREFIXES) || startsWithAny(pathname, MERCHANT_WELL_KNOWN)) {
      if (pathname === "/merchant" || pathname.startsWith("/merchant/")) {
        req.url = `/admin${pathname.slice("/merchant".length)}${url.search}`;
      }
      options.merchantHandler(req, res);
      return;
    }

    // 7) A2A 面：公开 Card/发现 + A2A 端点。
    if (startsWithAny(pathname, A2A_WELL_KNOWN) || a2aPaths.includes(pathname)) {
      options.a2aHandler(req, res);
      return;
    }

    // 8) 兜底：最小 404（不回显请求路径之外的信息）。
    writeJson(res, 404, { error: "not_found" }, NO_STORE);
  };
}
