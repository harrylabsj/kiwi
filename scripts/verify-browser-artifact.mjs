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

// 浏览器产物泄露检查（BD §15.3/§18.1：核验浏览器产物不含秘密/Node/Pi）。
//
// 检查对象：dist/http/merchant-management/page.js（当前唯一的浏览器绑定产物，
// 商家工作台静态壳）。断言渲染产物：
//   1. 可渲染且包含工作台标识；
//   2. 不含 Node/API 泄露形状（require( / node: / process.env）；
//   3. 不含私钥形状与会话/凭据名；
//   4. 不引用 Pi/模型侧词汇（pi-agent、pi-ai、model token 等）。

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => {
  console.error(`browser artifact leak check failed: ${message}`);
  process.exitCode = 1;
};

const pageModule = await import(
  pathToFileURL(resolve(root, "dist/http/merchant-management/page.js"))
);
if (typeof pageModule.renderMerchantManagementPage !== "function") {
  fail("dist page 模块缺少 renderMerchantManagementPage()");
  process.exit(process.exitCode ?? 1);
}
const html = pageModule.renderMerchantManagementPage();

if (html.length < 1000) fail("页面产物异常短");
if (!html.includes("商家工作台")) fail("页面缺少工作台标识");
if (!html.includes("/merchant/api/session")) fail("页面缺少管理 API 数据入口");

const leakPatterns = [
  [/require\s*\(/, "Node require("],
  [/node:[a-z]+/, "Node 内置模块引用"],
  [/process\.env/, "process.env 引用"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私钥形状"],
  [/kiwi_admin/, "管理会话 cookie 名"],
  [/client_secret/, "OAuth client secret 词汇"],
  [/pi-agent-core|pi-ai/, "Pi 依赖词汇"],
  [/api[_-]?key/i, "API key 词汇"],
];
for (const [pattern, label] of leakPatterns) {
  if (pattern.test(html)) fail(`页面产物包含 ${label}`);
}

// 源模块本身也不得有运行时依赖（浏览器绑定物必须是纯字符串模块）。
const pageSource = readFileSync(resolve(root, "dist/http/merchant-management/page.js"), "utf8");
if (/\bfrom\s+["'][^"']+["']|import\s+/.test(pageSource.replace(/^\/\*[\s\S]*?\*\//, ""))) {
  fail("page.js 含模块导入（浏览器产物必须是自包含模块）");
}

if (process.exitCode) process.exit(process.exitCode);
console.log("browser artifact leak check passed");
