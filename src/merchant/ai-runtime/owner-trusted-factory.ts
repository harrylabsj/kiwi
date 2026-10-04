/** Trusted local process capability boundary. No ambient credentials or JSON authority. */
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { HttpMerchantClient } from "../../agent/merchant/merchant-client.js";
import { createOwnerReadonlyFactsAdapter } from "./owner-readonly-facts.js";
import {
  OwnerFactoryError,
  parseOwnerFactoryConfig,
  type OwnerFactoryConfig,
} from "./owner-factory-config.js";
export type OwnerFactoryScope =
  "source.construct" | "source.read" | "provider.construct" | "provider.request";
export interface OwnerFactoryRequest {
  readonly scope: OwnerFactoryScope;
  readonly merchantId: string;
  readonly principal: string;
  readonly endpoint: string;
  readonly tenant: string;
  readonly credentialEnvRef: string;
  readonly api: string;
  readonly model: string;
  readonly reservationTokens: number;
  readonly dailyTokenLimit: number;
  readonly maxRequests: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}
declare const factoryBrand: unique symbol;
export type OwnerFactoryCapability = { readonly [factoryBrand]: true };
interface State {
  config: OwnerFactoryConfig;
  verify: (request: OwnerFactoryRequest) => boolean;
  resolve: (ref: string, request: OwnerFactoryRequest) => string | undefined;
  streams?: ProviderStreams;
}
const capabilities = new WeakMap<object, State>();
function request(state: State, scope: OwnerFactoryScope): OwnerFactoryRequest {
  const c = state.config,
    source = scope.startsWith("source.");
  return Object.freeze({
    scope,
    merchantId: c.references.runtimeMerchantId,
    principal: c.references.principal,
    endpoint: source ? c.source.endpoint : c.provider.endpoint,
    tenant: source ? c.source.tenant : c.provider.tenant,
    credentialEnvRef: source ? c.references.source.catalogTokenEnv : c.references.model.apiKeyEnv,
    api: source ? "shopping-cli-exact" : c.provider.api,
    model: source ? "" : c.references.model.model,
    reservationTokens: c.references.budget.reservationTokens,
    dailyTokenLimit: c.references.budget.dailyTokenLimit,
    maxRequests: c.provider.maxRequests,
    maxOutputTokens: c.provider.maxOutputTokens,
    timeoutMs: source ? c.source.timeoutMs : c.provider.timeoutMs,
  });
}
function state(cap: OwnerFactoryCapability): State {
  if (cap === null || typeof cap !== "object" || !capabilities.has(cap))
    throw new OwnerFactoryError("factory_authority_required");
  return capabilities.get(cap)!;
}
function check(s: State, scope: OwnerFactoryScope): OwnerFactoryRequest {
  const r = request(s, scope);
  try {
    if (s.verify(r) !== true) throw new Error();
  } catch {
    throw new OwnerFactoryError("factory_scope_not_approved");
  }
  return r;
}
function credential(s: State, scope: OwnerFactoryScope): string {
  const r = check(s, scope);
  let key: string | undefined;
  try {
    key = s.resolve(r.credentialEnvRef, r);
  } catch {
    throw new OwnerFactoryError("factory_credential_unavailable");
  }
  if (
    typeof key !== "string" ||
    !key ||
    /\s/.test(key) ||
    [...key].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  )
    throw new OwnerFactoryError("factory_credential_unavailable");
  check(s, scope);
  return key;
}
/** Only trusted host code supplies these functions; model/config JSON has no issuer. */
export function createOwnerFactoryAuthority(host: {
  verifyScope: (request: OwnerFactoryRequest) => boolean;
  resolveCredential: (envRef: string, request: OwnerFactoryRequest) => string | undefined;
  providerStreams?: ProviderStreams;
}) {
  if (typeof host?.verifyScope !== "function" || typeof host?.resolveCredential !== "function")
    throw new OwnerFactoryError("factory_authority_required");
  const { verifyScope: verify, resolveCredential: resolve } = host;
  const streams =
    host.providerStreams === undefined
      ? undefined
      : Object.freeze({
          stream: host.providerStreams.stream.bind(host.providerStreams),
          streamSimple: host.providerStreams.streamSimple.bind(host.providerStreams),
        });
  return Object.freeze({
    issue(config: OwnerFactoryConfig): OwnerFactoryCapability {
      const frozen = parseOwnerFactoryConfig(config, {
        merchantId: config.references.runtimeMerchantId,
        principal: config.references.principal,
      });
      const s: State = { config: frozen, verify, resolve, streams };
      check(s, "source.construct");
      check(s, "provider.construct");
      const cap = Object.freeze({}) as OwnerFactoryCapability;
      capabilities.set(cap, s);
      return cap;
    },
  });
}
export function ownerFactoryConfig(cap: OwnerFactoryCapability): OwnerFactoryConfig {
  return state(cap).config;
}
export function createOwnerTrustedSource(cap: OwnerFactoryCapability) {
  const s = state(cap);
  check(s, "source.construct");
  // Existing client sees only a catalog broker and is never exposed to the caller.
  const broker = {
    resolve: (scope: string) => {
      if (scope !== "catalog") throw new OwnerFactoryError("factory_scope_not_approved");
      return credential(s, "source.read");
    },
    has: (scope: string) => scope === "catalog",
  };
  const client = new HttpMerchantClient(s.config.source.endpoint, broker, {
    timeoutMs: s.config.source.timeoutMs,
  });
  const adapter = createOwnerReadonlyFactsAdapter(s.config.references, {
    getExactProduct: async (merchant, sku) => {
      check(s, "source.read");
      if (merchant !== s.config.source.tenant)
        throw new OwnerFactoryError("factory_source_binding_mismatch");
      const result = await client.getExactProduct(merchant, sku);
      check(s, "source.read");
      return result;
    },
  });
  return Object.freeze({ readFresh: adapter.readFresh });
}
export function createOwnerTrustedModels(cap: OwnerFactoryCapability): {
  readonly models: Models;
  readonly model: Readonly<{ provider: string; modelId: string }>;
} {
  const s = state(cap);
  check(s, "provider.construct");
  const c = s.config;
  const original = openaiProvider()
    .getModels()
    .find((m) => m.id === c.references.model.model && m.api === c.provider.api);
  if (original === undefined) throw new OwnerFactoryError("factory_model_unsupported");
  if (c.provider.maxOutputTokens > original.maxTokens)
    throw new OwnerFactoryError("factory_limit_invalid");
  const api = s.streams ?? openAIResponsesApi();
  // Host-supplied ProviderStreams is the official public interface, never StreamFn casts.
  const options = (o: Parameters<ProviderStreams["streamSimple"]>[2]) => {
    const key = credential(s, "provider.request");
    if (
      (o?.apiKey !== undefined && o.apiKey !== key) ||
      o?.env !== undefined ||
      o?.headers !== undefined
    )
      throw new OwnerFactoryError("factory_request_override_refused");
    if (o?.maxTokens !== undefined && (!Number.isSafeInteger(o.maxTokens) || o.maxTokens < 1))
      throw new OwnerFactoryError("factory_limit_invalid");
    if (o?.deferred !== undefined && o.deferred !== false)
      throw new OwnerFactoryError("factory_deferred_unsupported");
    const timeout = AbortSignal.timeout(c.provider.timeoutMs);
    const signal = o?.signal === undefined ? timeout : AbortSignal.any([o.signal, timeout]);
    signal.throwIfAborted();
    return {
      ...o,
      signal,
      apiKey: key,
      headers: { "OpenAI-Organization": c.provider.tenant },
      maxTokens: Math.min(o?.maxTokens ?? c.provider.maxOutputTokens, c.provider.maxOutputTokens),
    };
  };
  const pinnedModel = { ...original, baseUrl: c.provider.endpoint };
  const assertModel = (m: Parameters<ProviderStreams["streamSimple"]>[0]) => {
    if (
      m.id !== pinnedModel.id ||
      m.provider !== pinnedModel.provider ||
      m.api !== pinnedModel.api ||
      m.baseUrl !== pinnedModel.baseUrl
    )
      throw new OwnerFactoryError("factory_model_binding_mismatch");
    return pinnedModel;
  };
  const provider = createProvider({
    id: "openai",
    baseUrl: c.provider.endpoint,
    auth: {
      apiKey: {
        name: "Explicit host credential only",
        // A catalog/reference is not credential readiness; status never resolves secrets.
        check: async () => undefined,
        resolve: async () => ({ auth: { apiKey: credential(s, "provider.request") } }),
      },
    },
    models: [pinnedModel],
    api: {
      stream: (m, ctx, o) => api.stream(assertModel(m), ctx, options(o)),
      streamSimple: (m, ctx, o) => api.streamSimple(assertModel(m), ctx, options(o)),
    },
  });
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(provider);
  return Object.freeze({
    models,
    model: Object.freeze({ provider: "openai", modelId: original.id }),
  });
}
