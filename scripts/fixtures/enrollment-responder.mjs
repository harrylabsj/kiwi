/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 跨仓接入验证：先 npm run build，再运行本脚本。
 * 使用临时账号/密钥/数据库，ASGI 桥接代替网络；生产签名、验证、挑战应答和发布代码均真实执行。
 * 环境：相邻 kiwi-catalog/.venv，或指定 KIWI_CATALOG_REPO / KIWI_CATALOG_PYTHON。
 * 不部署、不访问公网，失败保留临时目录便于诊断。
 */
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { createEnrollmentChallengeResponder } = await import(
  pathToFileURL(`${config.runtimeRepo}/dist/cloud/binding/enrollment-challenge.js`).href
);
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const identity = {
  privateKey: createPrivateKey(readFileSync(config.runtimeKey)),
  keyid: config.keyId,
  algorithm: "ed25519",
};
const handler = createEnrollmentChallengeResponder({
  dataDir: config.dataDir,
  signingIdentity: identity,
});
const req = Readable.from([Buffer.from(raw)]);
req.method = "POST";
req.url = "/.well-known/kiwi-binding-challenge";
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("responder timeout")), 2000);
  const res = {
    headersSent: false,
    status: 200,
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(text) {
      clearTimeout(timer);
      console.log(JSON.stringify({ status: this.status, body: JSON.parse(text) }));
      resolve();
    },
  };
  handler(req, res);
});
