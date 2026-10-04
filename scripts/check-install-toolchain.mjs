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
 * A106 安装工具契约守卫（preinstall，fail-closed）。
 *
 * 背景（A92/A94/A97/A100 实证链）：
 *   - pi-coding-agent（含 0.87.1/1.0.0）shipped npm-shrinkwrap 钉嵌套
 *     brace-expansion 5.0.9（GHSA-q2hr-2g5m-vwhr / GHSA-qhr7-859c-m2p7 /
 *     GHSA-6j4f-fj2g-mc7p）；npm 10.9.8/11.16.0 无法用 override 穿透
 *     （六杠杆 + 修正锁条目均被忽略/回滚），fresh 安装会引入脆弱副本；
 *     npm 12.0.2 起 override 生效（唯一 5.0.12，audit 0）。
 *
 * 契约：本仓构建/开发/CI 安装必须使用 npm >=12.0.2 <13（配 Node >=22.19）。
 * 旧 npm 一律 fail-closed（零 provider/工具执行，无绕过开关）。
 * 注意：npm ≥12 的 devEngines 门对旧 npm 自身无效（旧版忽略新字段），
 * 故本脚本守卫是**权威**防线，devEngines 是对 npm≥12 的附加声明。
 */

// 版本来源优先级：1) 显式参数（CI 自检：node check… "$(npm --version)"，
// 真 CLI 输出、非伪造 UA）；2) npm_config_user_agent（npm 生命周期内由 npm
// 设置）。两者皆缺 = 非 npm 调用 → fail-closed。
const explicitVersion = process.argv[2];
const userAgent = process.env.npm_config_user_agent ?? "";
const parsed = /^npm\/(\d+\.\d+\.\d+)/.exec(userAgent);
const npmVersion = explicitVersion ?? parsed?.[1];
if (npmVersion === undefined) {
  console.error(
    "[a106] 不支持的调用方式：未提供版本参数且不在 npm 生命周期内" +
      `（user_agent=${JSON.stringify(userAgent)}）。` +
      "用法：node check-install-toolchain.mjs <npm --version 输出>，或在 npm 生命周期内运行。",
  );
  process.exit(1);
}

function isSupported(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major !== 12) return false;
  // >=12.0.2（12.0.0/12.0.1 未测，按未支持处理）
  return minor > 0 || patch >= 2;
}

if (!isSupported(npmVersion)) {
  console.error(
    `[a106] 不支持的安装器版本: npm ${npmVersion}（Node ${process.version}）。` +
      `本仓构建/安装契约要求 npm >=12.0.2 <13（官方取得：` +
      `corepack prepare npm@12.0.2 --activate，或 npm install -g npm@12.0.2）。` +
      `旧 npm 会引入 pi-coding-agent 嵌套 brace-expansion 5.0.9（audit high，` +
      `且 override 不生效）——拒绝安装（fail-closed，无绕过开关）。`,
  );
  process.exit(1);
}
console.log(`[a106] 安装工具契约 OK: npm ${npmVersion}（Node ${process.version}）`);
