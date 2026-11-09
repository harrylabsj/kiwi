/**
 * WorkBuddy Kiwi 商家本机适配器：OAuth 客户端。
 *
 * 分享门禁同时影响 discovery/register/token（以及浏览器登录），因此所有
 * 服务端请求都带 `X-Share-Code`；浏览器授权导航如必须带码，只放在 303/URL
 * query，不写日志。issuer/metadata 必须与固定实例同源，端点路径精确匹配。
 *
 * 本模块不打开浏览器、不读环境里的分享码；由调用方在受控输入后传入。
 */

import { createHash, randomBytes } from "node:crypto";

import { type FixedInstanceBinding, bindingFingerprint } from "./binding.js";
import { isLoopbackHost } from "../a2a/client/url-policy.js";
import type { StoredAdapterToken } from "./token-store.js";
import type { AdapterTokenStore } from "./token-store.js";

const TIMEOUT_MS = 12_000;
const MAX_BYTES = 512 * 1024;
const PATHS = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register",
  revoke: "/oauth/revoke",
} as const;

export interface AdapterOAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint?: string;
  /** 实例实际声明的 scope（setup 只允许在声明支持时提供 merchant:owner）。 */
  scopes_supported: string[];
}

const REMOTE_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  ...Object.values(PATHS),
]);

function assertRemotePath(url: URL, binding: FixedInstanceBinding): void {
  if (url.origin !== binding.issuer || !REMOTE_PATHS.has(url.pathname)) {
    throw new Error("远端地址不属于固定实例的预期 OAuth/MCP 端点");
  }
}

async function readLimited(response: Response): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("远端响应过大");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

async function remoteJson(
  url: string,
  binding: FixedInstanceBinding,
  shareCode: string,
  init: NonNullable<Parameters<typeof fetch>[1]>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("远端 URL 非法");
  }
  assertRemotePath(parsedUrl, binding);
  if (parsedUrl.search !== "" || parsedUrl.hash !== "") throw new Error("远端 URL 不得带 query/fragment");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          ...(shareCode !== "" ? { "x-share-code": shareCode } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch {
      throw new Error("远端不可达或超时");
    }
    if (response.status >= 300 && response.status < 400) throw new Error("拒绝跟随远端重定向");
    if (!response.ok) throw new Error(`远端 HTTP ${response.status}`);
    const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("application/json")) throw new Error("远端不是 JSON");
    const body = await readLimited(response);
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      throw new Error("远端 JSON 无法解析");
    }
  } finally {
    clearTimeout(timer);
  }
}

function endpoint(
  value: unknown,
  binding: FixedInstanceBinding,
  path: string,
): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.origin !== binding.issuer || url.pathname !== path) return undefined;
    if (url.search !== "" || url.hash !== "") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function discoverOAuth(
  binding: FixedInstanceBinding,
  shareCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdapterOAuthMetadata> {
  const metadata = await remoteJson(
    `${binding.issuer}/.well-known/oauth-authorization-server`,
    binding,
    shareCode,
    { method: "GET", headers: { accept: "application/json" } },
    fetchImpl,
  );
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("OAuth metadata 非法");
  }
  const record = metadata as Record<string, unknown>;
  if (typeof record.issuer !== "string" || new URL(record.issuer).origin !== binding.issuer) {
    throw new Error("OAuth issuer 与固定实例不同源");
  }
  const authorizationEndpoint = endpoint(record.authorization_endpoint, binding, PATHS.authorize);
  const tokenEndpoint = endpoint(record.token_endpoint, binding, PATHS.token);
  const registrationEndpoint = endpoint(record.registration_endpoint, binding, PATHS.register);
  const revocationEndpoint = endpoint(record.revocation_endpoint, binding, PATHS.revoke);
  if (authorizationEndpoint === undefined) throw new Error("authorization_endpoint 非法");
  if (tokenEndpoint === undefined) throw new Error("token_endpoint 非法");
  if (registrationEndpoint === undefined) throw new Error("registration_endpoint 非法");
  if (!Array.isArray(record.scopes_supported) || !record.scopes_supported.includes("merchant:read")) {
    throw new Error("实例未声明 merchant:read");
  }
  if (
    !Array.isArray(record.code_challenge_methods_supported) ||
    !record.code_challenge_methods_supported.includes("S256")
  ) {
    throw new Error("实例未声明 PKCE S256");
  }
  return Object.freeze({
    issuer: binding.issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    registration_endpoint: registrationEndpoint,
    ...(revocationEndpoint !== undefined ? { revocation_endpoint: revocationEndpoint } : {}),
    scopes_supported: [...record.scopes_supported],
  });
}

export async function registerAdapterClient(
  binding: FixedInstanceBinding,
  metadata: AdapterOAuthMetadata,
  redirectUri: string,
  shareCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const redirect = new URL(redirectUri);
  if (
    redirect.protocol !== "http:" ||
    !isLoopbackHost(redirect.hostname) ||
    redirect.pathname !== "/callback"
  ) {
    throw new Error("回调必须是本机 http loopback /callback");
  }
  const body = await remoteJson(
    metadata.registration_endpoint,
    binding,
    shareCode,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "kiwi-workbuddy-adapter",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
    fetchImpl,
  );
  const record = body as { client_id?: unknown; redirect_uris?: unknown };
  if (
    typeof record.client_id !== "string" ||
    record.client_id === "" ||
    !Array.isArray(record.redirect_uris) ||
    !record.redirect_uris.includes(redirectUri)
  ) {
    throw new Error("动态客户端注册响应非法");
  }
  return record.client_id;
}

export interface AdapterAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  verifier: string;
  state: string;
  codeChallenge: string;
  url: string;
}

export function createAuthorizationRequest(input: {
  binding: FixedInstanceBinding;
  metadata: AdapterOAuthMetadata;
  clientId: string;
  redirectUri: string;
  shareCode: string;
  /** 显式授权 scope；缺省仅 merchant:read。owner 必须由调用方明确选择。 */
  scopes?: readonly string[];
}): AdapterAuthorizationRequest {
  const scopes = [...(input.scopes ?? ["merchant:read"])];
  for (const scope of scopes) {
    if (scope !== "merchant:read" && scope !== "merchant:owner") {
      throw new Error(`不允许申请 scope：${scope}`);
    }
  }
  if (!scopes.includes("merchant:read")) {
    throw new Error("授权必须包含 merchant:read");
  }
  if (scopes.includes("merchant:owner") && !input.metadata.scopes_supported.includes("merchant:owner")) {
    throw new Error("实例未声明 merchant:owner，拒绝申请");
  }
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(input.metadata.authorization_endpoint);
  if (url.origin !== input.binding.issuer || url.pathname !== PATHS.authorize) {
    throw new Error("授权端点不属于固定实例");
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.shareCode !== "") url.searchParams.set("sharecode", input.shareCode);
  return {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    verifier,
    state,
    codeChallenge: challenge,
    url: url.toString(),
  };
}

export function validateAdapterToken(
  body: unknown,
  nowMs = Date.now(),
  allowedScopes?: readonly string[],
): StoredAdapterToken {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("token 响应非法");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.access_token !== "string" || record.access_token === "") {
    throw new Error("token 响应缺 access_token");
  }
  if (String(record.token_type ?? "").toLowerCase() !== "bearer") {
    throw new Error("token_type 必须是 Bearer");
  }
  if (typeof record.scope !== "string" || !record.scope.split(/\s+/).includes("merchant:read")) {
    throw new Error("token 未授予 merchant:read");
  }
  const scopes = record.scope.split(/\s+/).filter(Boolean);
  if (allowedScopes !== undefined && scopes.some((scope) => !allowedScopes.includes(scope))) {
    throw new Error("token 返回了本次未授权的 scope");
  }
  const expiresIn = Number(record.expires_in);
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
    throw new Error("token 响应缺合法 expires_in");
  }
  return {
    access_token: record.access_token,
    ...(typeof record.refresh_token === "string" && record.refresh_token !== ""
      ? { refresh_token: record.refresh_token }
      : {}),
    expires_at: new Date(nowMs + expiresIn * 1000).toISOString(),
    scope: scopes,
  };
}

async function tokenRequest(
  binding: FixedInstanceBinding,
  metadata: AdapterOAuthMetadata,
  shareCode: string,
  form: URLSearchParams,
  fetchImpl: typeof fetch,
  allowedScopes?: readonly string[],
): Promise<StoredAdapterToken> {
  const body = await remoteJson(
    metadata.token_endpoint,
    binding,
    shareCode,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
    },
    fetchImpl,
  );
  return validateAdapterToken(body, Date.now(), allowedScopes);
}

export async function exchangeAdapterCode(input: {
  binding: FixedInstanceBinding;
  metadata: AdapterOAuthMetadata;
  shareCode: string;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  /** 本次授权请求声明的 scope；token 返回超出即拒绝。 */
  scopes?: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<StoredAdapterToken> {
  return tokenRequest(
    input.binding,
    input.metadata,
    input.shareCode,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    }),
    input.fetchImpl ?? fetch,
    input.scopes,
  );
}

export async function refreshAdapterToken(input: {
  binding: FixedInstanceBinding;
  metadata: AdapterOAuthMetadata;
  shareCode: string;
  clientId: string;
  refreshToken: string;
  /** 原授权 scope；refresh 返回超出即拒绝。 */
  scopes?: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<StoredAdapterToken> {
  return tokenRequest(
    input.binding,
    input.metadata,
    input.shareCode,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    }),
    input.fetchImpl ?? fetch,
    input.scopes,
  );
}

export async function revokeAdapterToken(input: {
  binding: FixedInstanceBinding;
  metadata: AdapterOAuthMetadata;
  shareCode: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (input.metadata.revocation_endpoint === undefined) return false;
  try {
    await remoteJson(
      input.metadata.revocation_endpoint,
      input.binding,
      input.shareCode,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ token: input.token }).toString(),
      },
      input.fetchImpl ?? fetch,
    );
    return true;
  } catch {
    return false;
  }
}

/** 仅用于诊断：绑定指纹（不含 URL/token）。 */
export function adapterBindingId(binding: FixedInstanceBinding): string {
  return bindingFingerprint(binding).slice(0, 16);
}

/**
 * 读取 token store；临近过期且有 refresh token 时刷新并加密写回。
 * 无 refresh token/刷新失败 → 明确要求重新授权，不返回过期 token。
 */
export async function ensureAdapterToken(input: {
  store: AdapterTokenStore;
  binding: FixedInstanceBinding;
  metadata: AdapterOAuthMetadata;
  shareCode: string;
  clientId: string;
  fetchImpl?: typeof fetch;
}): Promise<StoredAdapterToken> {
  const current = input.store.load();
  if (current === undefined) throw new Error("尚未授权：token store 为空");
  if (!input.store.isExpired(current)) return current;
  if (current.refresh_token === undefined) {
    throw new Error("access token 已过期且无 refresh token，需要重新授权");
  }
  const refreshed = await refreshAdapterToken({
    binding: input.binding,
    metadata: input.metadata,
    shareCode: input.shareCode,
    clientId: input.clientId,
    refreshToken: current.refresh_token,
    scopes: current.scope,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  });
  const preserved: StoredAdapterToken = {
    ...refreshed,
    ...(current.share_code !== undefined ? { share_code: current.share_code } : {}),
  };
  input.store.save(preserved);
  return preserved;
}
