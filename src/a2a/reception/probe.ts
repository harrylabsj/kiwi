/**
 * 接待五层健康探针（设计 §17）。
 *
 * P0a 实现前三层，并把后两层显式标为 unknown，避免“配置存在”被误报成
 * “接待可用”：
 *   ① configured      配置与凭据引用齐备（只看存在性，不读值）
 *   ② connected       真实 provider 连接成功
 *   ③ non_empty_output 目标 prompt 下正文非空（防 reasoning token 吃满预算）
 *   ④ tools           受控工具调用（P0a 未接，unknown）
 *   ⑤ channel         渠道启用（由调用方传入）
 *
 * 安全：不记录密钥值、不记录响应正文；失败只返回固定原因码。
 */

import { RECEPTION_CONFIG_DEFAULTS } from "./config.js";

export type ProbeLayerState = "ok" | "failed" | "unknown";

export interface ReceptionProbeResult {
  ok: boolean;
  checked_at: string;
  layers: {
    configured: ProbeLayerState;
    connected: ProbeLayerState;
    non_empty_output: ProbeLayerState;
    tools: ProbeLayerState;
    channel: ProbeLayerState;
  };
  /** 固定原因码，不含密钥或响应正文。 */
  reason?: "disabled" | "missing_credential" | "missing_config" | "provider_error" | "empty_output";
}

export interface ReceptionProbeOptions {
  enabled: boolean;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  channelEnabled?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  lookupEnv?: (name: string) => string | undefined;
  now: () => string;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
/** 与接待一致：reasoning token 与正文共享预算，200 会正文恒空。 */
const PROBE_MAX_TOKENS = 1_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export async function probeReceptionModel(
  options: ReceptionProbeOptions,
): Promise<ReceptionProbeResult> {
  const checkedAt = options.now();
  const lookupEnv = options.lookupEnv ?? ((name) => process.env[name]);
  const apiKeyEnv = options.apiKeyEnv ?? "DEEPSEEK_API_KEY";
  const base = {
    checked_at: checkedAt,
    layers: {
      configured: "failed" as ProbeLayerState,
      connected: "unknown" as ProbeLayerState,
      non_empty_output: "unknown" as ProbeLayerState,
      tools: "unknown" as ProbeLayerState,
      channel:
        options.channelEnabled === true
          ? ("ok" as const)
          : options.channelEnabled === false
            ? ("failed" as const)
            : ("unknown" as const),
    },
  };

  if (!options.enabled) {
    return { ...base, ok: false, reason: "disabled" };
  }
  if ((options.model ?? DEFAULT_MODEL).trim() === "" || apiKeyEnv.trim() === "") {
    return { ...base, ok: false, reason: "missing_config" };
  }
  if ((lookupEnv(apiKeyEnv) ?? "") === "") {
    return { ...base, ok: false, reason: "missing_credential" };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(
      `${options.baseUrl ?? DEFAULT_BASE_URL}/v1/chat/completions`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${lookupEnv(apiKeyEnv)}`,
        },
        body: JSON.stringify({
          model: options.model ?? DEFAULT_MODEL,
          temperature: 0,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [
            {
              role: "system",
              content: "Reply with exactly one short Chinese sentence confirming you are ready.",
            },
            { role: "user", content: "请回复一句简短的中文确认。" },
          ],
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return {
        ...base,
        ok: false,
        layers: { ...base.layers, configured: "ok", connected: "failed" },
        reason: "provider_error",
      };
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    const nonEmpty = typeof content === "string" && content.trim() !== "";
    const layers = {
      ...base.layers,
      configured: "ok" as const,
      connected: "ok" as const,
      non_empty_output: nonEmpty ? ("ok" as const) : ("failed" as const),
    };
    return nonEmpty
      ? { ...base, ok: layers.channel !== "failed", layers }
      : { ...base, ok: false, layers, reason: "empty_output" };
  } catch {
    return {
      ...base,
      ok: false,
      layers: { ...base.layers, configured: "ok", connected: "failed" },
      reason: "provider_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

export const RECEPTION_PROBE_DEFAULTS = Object.freeze({
  maxTokens: PROBE_MAX_TOKENS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  defaults: RECEPTION_CONFIG_DEFAULTS,
});
