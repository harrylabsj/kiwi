/** Explicit trusted-process assembly, never an env/JSON approval bootstrap. */
import { existsSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  LocalMerchantOwnerSession,
  merchantStorageDir,
  ownerSessionFullyEnabled,
  type OwnerSessionSwitches,
} from "./owner-session.js";
import {
  assertOwnerStorageAdmission,
  assertOwnerStorageReady,
  type OwnerStorageAdmission,
} from "./owner-storage-admission.js";
import { createFileGrantResolver } from "./owner-file-grant.js";
import { createOwnerBudgetGate } from "./owner-budget-gate.js";
import { OwnerFactoryError } from "./owner-factory-config.js";
import {
  createOwnerTrustedModels,
  createOwnerTrustedSource,
  ownerFactoryConfig,
  type OwnerFactoryCapability,
} from "./owner-trusted-factory.js";
export function createOwnerLocalReadonlyHost(input: {
  storageRoot: string;
  merchantId: string;
  principal: string;
  grantFile: string;
  switches: OwnerSessionSwitches;
  storageAdmission: OwnerStorageAdmission;
  factoryCapability: OwnerFactoryCapability;
}) {
  if (!ownerSessionFullyEnabled(input.switches)) throw new OwnerFactoryError("owner_disabled");
  const config = ownerFactoryConfig(input.factoryCapability);
  if (
    config.references.runtimeMerchantId !== input.merchantId ||
    config.references.principal !== input.principal
  )
    throw new OwnerFactoryError("factory_host_binding_mismatch");
  assertOwnerStorageAdmission(input.storageAdmission, input);
  assertOwnerStorageReady(input.storageAdmission);
  const grant = createFileGrantResolver(input);
  const check = () => {
    const result = grant.readStrong(input.grantFile);
    if (!result.ok) throw new OwnerFactoryError(result.code);
  };
  check();
  const dbPath = join(merchantStorageDir(input.storageRoot, input.merchantId), "budget.sqlite");
  if (resolve(config.references.budget.dbPath) !== resolve(dbPath))
    throw new OwnerFactoryError("factory_budget_path_mismatch");
  if (existsSync(dbPath)) {
    const st = lstatSync(dbPath);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      (st.mode & 0o777) !== 0o600 ||
      (process.getuid !== undefined && st.uid !== process.getuid())
    )
      throw new OwnerFactoryError("factory_budget_file_untrusted");
  }
  const provider = createOwnerTrustedModels(input.factoryCapability),
    source = createOwnerTrustedSource(input.factoryCapability);
  const budget = createOwnerBudgetGate({
    dbPath,
    config: {
      enabled: true,
      provider: "openai",
      model: config.references.model.model,
      api_key_env: config.references.model.apiKeyEnv,
      turn: {
        deadline_ms: config.provider.timeoutMs,
        max_steps: config.provider.maxRequests,
        // Existing gate bounds reservation estimates; actual provider output has its
        // separate stricter maxOutputTokens parameter in the trusted factory.
        max_output_tokens: Math.max(
          config.provider.maxOutputTokens,
          config.references.budget.reservationTokens,
        ),
      },
      concurrency: { max_inflight_global: 1, max_inflight_per_merchant: 1 },
      budget: { daily_token_limit: config.references.budget.dailyTokenLimit },
    },
  });
  let owner: LocalMerchantOwnerSession;
  try {
    owner = new LocalMerchantOwnerSession({
      ...input,
      budgetGate: budget.budgetGate,
      sdkRuntime: {
        ...provider,
        reservationTokens: config.references.budget.reservationTokens,
        maxRequests: config.provider.maxRequests,
        timeoutMs: config.provider.timeoutMs,
        tools: [],
      },
    });
  } catch (error) {
    budget.close();
    throw error;
  }
  let closed = false;
  let inFlight = false;
  const active = () => {
    if (closed) throw new OwnerFactoryError("owner_closed");
    check();
    assertOwnerStorageReady(input.storageAdmission);
  };
  return Object.freeze({
    async readFresh(sku: string) {
      active();
      const facts = await source.readFresh(sku);
      active();
      return facts;
    },
    async converse(text: string) {
      active();
      if (inFlight) throw new OwnerFactoryError("owner_busy");
      inFlight = true;
      try {
        return await owner.submitTurn({ text, mode: "converse" });
      } finally {
        inFlight = false;
      }
    },
    async history(limit = 50) {
      active();
      return owner.history(limit);
    },
    close() {
      if (inFlight) throw new OwnerFactoryError("owner_busy");
      if (!closed) {
        closed = true;
        owner.release();
        budget.close();
      }
    },
  });
}
