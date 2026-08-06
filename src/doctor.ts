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
 * `kiwi doctor` — read-only diagnostics. Never performs negotiation writes
 * and never prints secret values.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  findInlineSecrets,
  loadProfile,
  ProfileError,
  type AgentProfile,
} from "./config/profile.js";
import type { CommerceClient } from "./commerce/types.js";
import { CommerceError } from "./commerce/types.js";
import { PROTOCOL_VERSION } from "./negotiation/types.js";
import { toolAllowlistForRole } from "./runtime/tools.js";
import { buildModel, isFakeProvider } from "./runtime/model.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export function runDoctor(profilePath: string, client?: CommerceClient): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  // 1. Profile loads and validates.
  let profile: AgentProfile;
  try {
    profile = loadProfile(profilePath);
    add("profile", true, `${profile.agent_id} role=${profile.role}`);
  } catch (err) {
    if (err instanceof ProfileError) {
      add("profile", false, err.message);
      return Promise.resolve({ ok: false, checks });
    }
    throw err;
  }

  // 2. No inline secrets in the profile file.
  try {
    const raw = parseYaml(readFileSync(profilePath, "utf-8")) as unknown;
    const leaks = findInlineSecrets(raw);
    add(
      "secrets",
      leaks.length === 0,
      leaks.length === 0
        ? "secrets referenced via env vars only"
        : `possible inline secrets at: ${leaks.join(", ")}`,
    );
  } catch {
    add("secrets", false, "could not re-parse profile for secret scan");
  }

  // 3. Env vars present (presence only — values are never read or printed).
  const tokenSet = Boolean(process.env[profile.commerce.token_env]);
  add(
    "commerce_token_env",
    tokenSet,
    tokenSet ? `${profile.commerce.token_env} is set` : `${profile.commerce.token_env} is NOT set`,
  );
  if (!isFakeProvider(profile) && profile.model.api_key_env !== undefined) {
    const keySet = Boolean(process.env[profile.model.api_key_env]);
    add(
      "model_api_key_env",
      keySet,
      keySet ? `${profile.model.api_key_env} is set` : `${profile.model.api_key_env} is NOT set`,
    );
  } else {
    add(
      "model_api_key_env",
      true,
      isFakeProvider(profile) ? "fake provider: no key needed" : "no api_key_env configured",
    );
  }

  // 4. Model resolution.
  try {
    const model = buildModel(profile);
    add("model", true, `provider=${model.provider} api=${model.api} model=${model.id}`);
  } catch (err) {
    add("model", false, err instanceof Error ? err.message : String(err));
  }

  // 5. Tool allowlist.
  add("tools", true, `allowlist: ${toolAllowlistForRole(profile.role).join(", ")}`);

  // 6. Commerce API health + protocol/capability compatibility.
  return (async () => {
    if (client) {
      try {
        const health = await client.health();
        add(
          "commerce_health",
          health.ok,
          health.ok
            ? `${health.service ?? "commerce"} ${health.version ?? ""}`.trim()
            : "health check failed",
        );
      } catch (err) {
        add("commerce_health", false, describeError(err));
      }
      try {
        const caps = await client.getCapabilities();
        const protoOk = caps.protocol_versions.includes(PROTOCOL_VERSION);
        add(
          "protocol",
          protoOk,
          protoOk
            ? `gateway supports ${PROTOCOL_VERSION}`
            : `gateway protocols: ${caps.protocol_versions.join(", ")}`,
        );
        const missing = ["consultation_read", "consultation_write", "inventory_read"].filter(
          (c) => !caps.capabilities[c as keyof typeof caps.capabilities],
        );
        add(
          "capabilities",
          missing.length === 0 && caps.capabilities.orders === false,
          missing.length === 0
            ? caps.capabilities.orders === false
              ? "required capabilities present; orders=false (no-order boundary)"
              : "orders capability must be false"
            : `missing capabilities: ${missing.join(", ")}`,
        );
      } catch (err) {
        add("capabilities", false, describeError(err));
      }
    }
    return { ok: checks.every((c) => c.ok), checks };
  })();
}

function describeError(err: unknown): string {
  if (err instanceof CommerceError) return `${err.kind}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
