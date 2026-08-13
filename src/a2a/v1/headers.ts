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
 * A2A 请求头（issue 05）：`A2A-Version` 解析/校验、`A2A-Extensions` 激活 KNP /
 * 未知扩展 fail-closed。KNP extension path 与 Card 声明单一来源
 * （`discovery/agent-card/types.ts` 的 `KIWI_NEGOTIATION_EXTENSION_PATH`）。
 */

import { KIWI_NEGOTIATION_EXTENSION_PATH } from "../../discovery/agent-card/index.js";

export const A2A_VERSION_HEADER = "A2A-Version";
export const A2A_EXTENSIONS_HEADER = "A2A-Extensions";
/** 支持的最高协议版本（本实现）。 */
export const SUPPORTED_A2A_VERSION = "1.0";

/** KNP extension path（与 Agent Card 声明单一来源）。 */
export const KNP_EXTENSION_PATH = KIWI_NEGOTIATION_EXTENSION_PATH;

/** 解析 `A2A-Version` 头：空/缺省 → undefined；否则 trim 后返回。 */
export function parseVersion(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const v = header.trim();
  return v === "" ? undefined : v;
}

/** 解析 `A2A-Extensions` 头：逗号分隔 URI，去空白，过滤空。 */
export function parseExtensions(header: string | undefined): string[] {
  if (header === undefined || header.trim() === "") return [];
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * 激活/拒绝扩展（fail-closed）：
 * - 请求声明了服务器**不支持的扩展** → 抛错（未知扩展拒绝）；
 * - 支持集内含 KNP extension path → `knpActive: true`。
 */
export function activateKnp(
  extensions: string[],
  supportedUris: ReadonlySet<string>,
): { knpActive: boolean } {
  const unknown = extensions.filter((uri) => !supportedUris.has(uri));
  if (unknown.length > 0) {
    throw new Error(`unsupported A2A extension(s): ${unknown.join(", ")}`);
  }
  return { knpActive: extensions.some((uri) => uri.endsWith(KNP_EXTENSION_PATH)) };
}
