/**
 * Credential Broker (design §15.4).
 *
 * Negotiation / catalog / inventory credentials are held separately by scope.
 * The model only ever sees tools — never tokens. A write tool whose scope has
 * no credential configured fails closed: it refuses to touch the marketplace
 * rather than degrading to an unauthenticated or mis-scoped call.
 *
 * The negotiation scope is the profile's primary `commerce.token_env`;
 * catalog and inventory scopes come from the optional
 * `commerce.credentials.<scope>.token_env` refs. Tokens are resolved lazily at
 * call time via process.env, exactly like the negotiation token — nothing is
 * ever stored in the profile or in logs.
 */

import type { CommerceCredentialScope } from "../../config/profile.js";
import type { AgentProfile } from "../../config/profile.js";

/** The broker never logs or exposes token values; only scopes are queryable. */
export interface CredentialBroker {
  /** Token for a scope, or undefined when that scope is not configured. */
  resolve(scope: CommerceCredentialScope): string | undefined;
  /** Whether a token is configured for the scope (not whether it is valid). */
  has(scope: CommerceCredentialScope): boolean;
}

/** Fail-closed helper shared by write tools: no credential -> refuse. */
export function requireScopeCredential(
  broker: CredentialBroker,
  scope: CommerceCredentialScope,
): { ok: true; token: string } | { ok: false; reason: string } {
  const token = broker.resolve(scope);
  if (token === undefined || token === "") {
    return {
      ok: false,
      reason:
        `没有 ${scope} 作用域的凭据（commerce.credentials.${scope}.token_env 未配置），` +
        `该写操作已安全拒绝（fail closed）。`,
    };
  }
  return { ok: true, token };
}

/** Resolve a token from an env-var reference, never logging the value. */
function resolveEnv(envName: string | undefined): string | undefined {
  if (envName === undefined) return undefined;
  const value = process.env[envName];
  return value === undefined || value === "" ? undefined : value;
}

/** Env-backed broker derived from a profile's commerce credential refs. */
export class ProfileCredentialBroker implements CredentialBroker {
  private readonly profile: AgentProfile;

  constructor(profile: AgentProfile) {
    this.profile = profile;
  }

  resolve(scope: CommerceCredentialScope): string | undefined {
    if (scope === "negotiation") return resolveEnv(this.profile.commerce.token_env);
    return resolveEnv(this.profile.commerce.credentials?.[scope]?.token_env);
  }

  has(scope: CommerceCredentialScope): boolean {
    return this.resolve(scope) !== undefined;
  }
}

/** Explicit-map broker for tests and embedded use (keys are env-var names). */
export class EnvRefCredentialBroker implements CredentialBroker {
  private readonly refs: Partial<Record<CommerceCredentialScope, string>>;

  constructor(refs: Partial<Record<CommerceCredentialScope, string>>) {
    this.refs = refs;
  }

  resolve(scope: CommerceCredentialScope): string | undefined {
    return resolveEnv(this.refs[scope]);
  }

  has(scope: CommerceCredentialScope): boolean {
    return this.resolve(scope) !== undefined;
  }
}

/** Literal-value broker for deterministic tests (values never logged). */
export class StaticCredentialBroker implements CredentialBroker {
  private readonly tokens: Partial<Record<CommerceCredentialScope, string>>;

  constructor(tokens: Partial<Record<CommerceCredentialScope, string>>) {
    this.tokens = tokens;
  }

  resolve(scope: CommerceCredentialScope): string | undefined {
    return this.tokens[scope];
  }

  has(scope: CommerceCredentialScope): boolean {
    return this.tokens[scope] !== undefined && this.tokens[scope] !== "";
  }
}
