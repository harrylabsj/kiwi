#!/usr/bin/env node
// Copyright 2026 harrylabsj
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// WorkBuddy 平台行为回显探针（I-01 服务端一半）：
//
//   node scripts/workbuddy-echo.mjs --port 8787
//
// 把这个服务作为 WorkBuddy 网站应用发布，再从外部调用，即可自己量出网关是否
// 剥除/重排查询参数、是否改写或注入 Authorization、签名头是否原样透传。
// 输出只含参数名、头名与值摘要；令牌与分享码的值永不回显。
//
// 也可以直接在本机用它自测客户端（scripts/probe-workbuddy-gate.mjs）。

import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { createProbeHandler } from "../dist/tools/workbuddy-echo.js";

const USAGE = `usage: node scripts/workbuddy-echo.mjs [--host 0.0.0.0] [--port 8787]

Serves /__probe/echo (request summary, no secret values) and /__probe/health.
Requires a prior build (npm run build).`;

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help === true) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const host = values.host ?? process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(values.port ?? process.env.PORT ?? "8787", 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  process.stderr.write("error: --port must be 0..65535\n");
  process.exit(2);
}

const handler = createProbeHandler();
const server = createServer((req, res) => {
  void handler(req)
    .then(({ status, body }) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(payload)),
        "cache-control": "no-store",
      });
      res.end(payload);
    })
    .catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"internal"}');
    });
});

server.listen(port, host, () => {
  const address = server.address();
  const shown = typeof address === "object" && address !== null ? address.port : port;
  process.stdout.write(`workbuddy echo probe listening on http://${host}:${shown}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
