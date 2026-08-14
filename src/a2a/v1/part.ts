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
 * A2A Part 编解码 + KNP DataPart 映射（issue 04，高风险点）。
 *
 * 0.3（`{kind:"text"|"data"}`）↔ 1.0（统一 Part，字段存在性判别）双向转换。
 * KNP 载荷（`knp_envelope` / `agreement`）必须无损往返——磋商内核（envelope
 * 解析/相位机）100% 复用，只在传输帧层转换。
 */

import type { A2APart } from "../client/types.js";
import type { A2AV1Part, DataPart } from "./types.js";

/** KNP 载荷承载的 mediaType（KNP envelope 是 JSON）。 */
export const KNP_DATA_MEDIA_TYPE = "application/json";

/**
 * 0.3 Part → 1.0 统一 Part。
 * - text → TextPart；
 * - data → DataPart（data 原样 + KNP mediaType）。
 */
export function encodeV1Part(legacy: A2APart): A2AV1Part {
  if (legacy.kind === "text") return { text: legacy.text };
  return { data: legacy.data, mediaType: KNP_DATA_MEDIA_TYPE };
}

/**
 * 1.0 统一 Part → 0.3 Part。
 * - TextPart → text；
 * - DataPart → data（原样还原）。
 * - URLPart/FilePart 在 0.3 模型无等价（0.3 只建模 text/data）→ fail-closed。
 */
export function decodeV1Part(v1: A2AV1Part): A2APart {
  if ("text" in v1) return { kind: "text", text: v1.text };
  if ("data" in v1) return { kind: "data", data: v1.data };
  throw new Error(
    `v1 Part 无法映射到 0.3 模型（0.3 只建模 text/data）：${JSON.stringify(v1).slice(0, 200)}`,
  );
}

/** 识别 KNP 载荷 Part（data 内含 knp_envelope 或 agreement）。 */
export function isKnpDataPart(part: A2AV1Part): part is DataPart {
  // JSON-RPC 输入来自远端，不能假定调用方已经完成了 TypeScript 类型
  // 收窄。`in` 对 null/primitive 会抛 TypeError，进而把坏请求错误地升级为
  // -32603 internal error。这里必须先做运行时对象守卫，保持 fail-closed。
  if (part === null || typeof part !== "object" || Array.isArray(part)) return false;
  if (!("data" in part)) return false;
  const data = (part as { data?: unknown }).data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  return "knp_envelope" in data || "agreement" in data;
}

/**
 * 输入 Part 是否受支持（issue 10 / TCK CORE-SEND-003）。fail-closed：未知
 * 形状一律不支持。TextPart 直接支持；DataPart 仅当 mediaType 为
 * application/json（含 KNP）；带其他 mediaType（如 raw/file/url）不支持 →
 * server 返回 ContentTypeNotSupportedError（-32005），而非内部错误。
 */
export function isV1InputPartSupported(part: A2AV1Part): boolean {
  if (typeof part !== "object" || part === null || Array.isArray(part)) return false;
  if ("text" in part) return typeof (part as { text?: unknown }).text === "string";
  const mediaType =
    "mediaType" in part && typeof (part as { mediaType?: unknown }).mediaType === "string"
      ? (part as { mediaType: string }).mediaType
      : undefined;
  if ("data" in part) {
    const data = (part as { data?: unknown }).data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
    if (mediaType === undefined) return false;
    return mediaType.startsWith("text/") || mediaType === "application/json";
  }
  if ("raw" in part) {
    return (
      typeof (part as { raw?: unknown }).raw === "string" &&
      mediaType !== undefined &&
      (mediaType.startsWith("text/") || mediaType === "application/json")
    );
  }
  if ("url" in part) {
    return typeof (part as { url?: unknown }).url === "string";
  }
  return false;
}
