#!/usr/bin/env node
/**
 * Minimal first-publish bootstrap for the Kiwi merchant reception app.
 *
 * Purpose: let WorkBuddy publish a directory once so that prepare.mjs can
 * receive the resulting public --origin. This is not the merchant runtime:
 * it has no dependencies, makes no network calls, performs no version
 * resolution, and must be replaced by the prepared deployment on the second
 * publish. It contains no merchant data or credentials.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;

const ROOT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiwi 商家接待</title>
</head>
<body>
<main>
<h1>Kiwi 商家接待</h1>
<p>首次发布取址占位入口已启动。</p>
<p>请回到开通顾问继续 prepare；本页不代表正式运行时已就绪。</p>
</main>
</body>
</html>
`;

function respond(res, status, contentType, body, method) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  res.end(method === "HEAD" ? undefined : body);
}

export function createFirstPublishServer() {
  return createServer((req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, {
        allow: "GET, HEAD",
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }) + "\n");
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://first-publish.invalid").pathname;
    } catch {
      respond(res, 400, "text/plain; charset=utf-8", "bad request\n", method);
      return;
    }

    if (pathname === "/livez") {
      respond(res, 200, "text/plain; charset=utf-8", "ok\n", method);
      return;
    }
    if (pathname === "/readyz") {
      // Never claim runtime readiness from the first-publish placeholder.
      respond(
        res,
        503,
        "application/json; charset=utf-8",
        JSON.stringify({ ready: false, reason: "first_publish_bootstrap" }) + "\n",
        method,
      );
      return;
    }
    if (pathname === "/") {
      respond(res, 200, "text/html; charset=utf-8", ROOT_HTML, method);
      return;
    }
    respond(res, 404, "text/plain; charset=utf-8", "not found\n", method);
  });
}

export function startFirstPublishServer({
  host = process.env.HOST || DEFAULT_HOST,
  port = process.env.PORT || String(DEFAULT_PORT),
} = {}) {
  const resolvedPort = Number.parseInt(String(port), 10);
  if (!Number.isInteger(resolvedPort) || resolvedPort < 0 || resolvedPort > 65535) {
    throw new Error("PORT_INVALID");
  }
  const server = createFirstPublishServer();
  server.listen(resolvedPort, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : resolvedPort;
    process.stdout.write(`first-publish bootstrap listening on ${host}:${actualPort}\n`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = startFirstPublishServer();
  const shutdown = (signal) => {
    process.stdout.write(`first-publish bootstrap received ${signal}; shutting down\n`);
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
