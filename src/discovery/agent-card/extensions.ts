/**
 * Kiwi Negotiation A2A Extension URI 识别（基线 §8.2 / §26）。
 *
 * 规范形态：
 *   https://<domain>/a2a/extensions/negotiation/1.0
 *
 * authority 在示例中为 kiwi.example，但识别规则只看 path 形态与 scheme，不绑定
 * 具体 domain——生产部署时由 Kiwi 实际控制的域发布（§8.2 要求生产前替换示例
 * authority）。非 http(s) scheme / 带 userinfo / 无 authority 均不识别。
 */

import { KIWI_NEGOTIATION_EXTENSION_PATH } from "./types.js";
import type { AgentCard } from "./types.js";

/** 判断一个 URI 是否是 Kiwi negotiation extension URI（§8.2 形态）。 */
export function isNegotiationExtensionUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.hostname.length === 0) return false;
  return url.pathname === KIWI_NEGOTIATION_EXTENSION_PATH;
}

/** 从 card 的 extensions 声明中查找 negotiation extension（capabilities 与顶层都查）。 */
export function findNegotiationExtensions(card: AgentCard): string[] {
  const uris: string[] = [];
  const collect = (exts: { uri: string; required: boolean }[] | undefined): void => {
    if (exts === undefined) return;
    for (const ext of exts) {
      if (isNegotiationExtensionUri(ext.uri)) uris.push(ext.uri);
    }
  };
  collect(card.capabilities?.extensions);
  collect(card.extensions);
  return uris;
}
