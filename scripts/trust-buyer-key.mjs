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
// 商家侧可信买家公钥登记（B-05 运维入口）。
//
//   node scripts/trust-buyer-key.mjs --data-dir /var/lib/kiwi-merchant \
//     --keyid buyer.example --pem ./buyer.pub.pem [--identity buyer-1] [--trust-level T1] [--replace]
//   node scripts/trust-buyer-key.mjs --data-dir … --list
//
// 写入的是运行时数据目录下的 a2a-trusted-keys.json（0600），运行时每次请求
// 重新读取，登记后立即生效；受保护操作从此认可该买家的签名身份。

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { addTrustedBuyerKey, readTrustedKeys, trustedKeysPath } from "../dist/tools/trusted-buyer-keys.js";

const USAGE = `usage: node scripts/trust-buyer-key.mjs --data-dir <dir> (--keyid <id> --pem <file> | --list)
       [--identity <name>] [--organization <org>] [--role buyer|merchant]
       [--trust-level T0|T1|T2|T3] [--replace]

Requires a prior build (npm run build). The PEM must be Ed25519 (SPKI).`;

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    keyid: { type: "string" },
    pem: { type: "string" },
    identity: { type: "string" },
    organization: { type: "string" },
    role: { type: "string" },
    "trust-level": { type: "string" },
    replace: { type: "boolean" },
    list: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help === true) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const dataDir = String(values["data-dir"] ?? "").trim();
if (dataDir === "") {
  process.stderr.write("error: --data-dir is required\n");
  process.exit(2);
}
const file = trustedKeysPath(dataDir);

if (values.list === true) {
  const keys = readTrustedKeys(file);
  process.stdout.write(
    `${JSON.stringify(
      { path: file, count: keys.length, keys: keys.map((k) => ({ keyid: k.keyid, profile: k.profile ?? null })) },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const keyid = String(values.keyid ?? "").trim();
const pemFile = String(values.pem ?? "").trim();
if (keyid === "" || pemFile === "") {
  process.stderr.write("error: --keyid and --pem are required (or use --list)\n");
  process.exit(2);
}
if (!existsSync(pemFile)) {
  process.stderr.write(`error: PEM file not found: ${pemFile}\n`);
  process.exit(2);
}

const role = values.role === undefined ? undefined : String(values.role);
if (role !== undefined && role !== "buyer" && role !== "merchant") {
  process.stderr.write("error: --role must be buyer or merchant\n");
  process.exit(2);
}
const trustLevel = values["trust-level"] === undefined ? undefined : String(values["trust-level"]);
if (trustLevel !== undefined && !["T0", "T1", "T2", "T3"].includes(trustLevel)) {
  process.stderr.write("error: --trust-level must be T0..T3\n");
  process.exit(2);
}

const profile = {
  ...(typeof values.identity === "string" ? { identity: values.identity } : {}),
  ...(typeof values.organization === "string" ? { organization: values.organization } : {}),
  ...(role !== undefined ? { role } : {}),
  ...(trustLevel !== undefined ? { trustLevel } : {}),
};

try {
  const result = addTrustedBuyerKey(
    file,
    {
      keyid,
      publicKeyPem: readFileSync(pemFile, "utf8"),
      ...(Object.keys(profile).length > 0 ? { profile } : {}),
    },
    { replace: values.replace === true },
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, added: result.added, replaced: !result.added, keyid, path: result.path }, null, 2)}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
