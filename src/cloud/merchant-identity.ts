import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fs/atomic-write.js";
import type { AgentProfile } from "../config/profile.js";

export interface PersistedMerchantIdentity {
  schema_version: 1;
  agent_id: string;
  owner_id: string;
  created_at: string;
  display_name?: string;
  merchant_name_needs_update?: boolean;
}

export function merchantIdentityPath(dataDir: string): string {
  return path.join(dataDir, "merchant-identity.json");
}

function readIdentity(file: string): PersistedMerchantIdentity {
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedMerchantIdentity>;
  if (
    value.schema_version !== 1 ||
    typeof value.agent_id !== "string" || value.agent_id.trim() === "" ||
    typeof value.owner_id !== "string" || value.owner_id.trim() === "" ||
    typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))
  ) throw new Error("商家身份状态文件格式无效；拒绝使用部署目录中的新身份覆盖状态");
  chmodSync(file, 0o600);
  return value as PersistedMerchantIdentity;
}

/** 首次启动固定身份；后续重部署一律以状态目录中的身份为准。 */
export function loadOrCreateMerchantIdentity(
  dataDir: string,
  profile: AgentProfile,
  options: { merchantNameNeedsUpdate?: boolean } = {},
): AgentProfile {
  const file = merchantIdentityPath(dataDir);
  if (existsSync(file)) {
    const identity = readIdentity(file);
    const preserveExistingName = options.merchantNameNeedsUpdate === true;
    const displayName = preserveExistingName ? identity.display_name ?? profile.name : profile.name;
    const nameNeedsUpdate = preserveExistingName
      ? identity.merchant_name_needs_update ?? true
      : false;
    const updated: PersistedMerchantIdentity = {
      ...identity,
      ...(displayName !== undefined ? { display_name: displayName } : {}),
      merchant_name_needs_update: nameNeedsUpdate,
    };
    if (JSON.stringify(updated) !== JSON.stringify(identity)) writeFileAtomic(file, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    return {
      ...profile,
      agent_id: identity.agent_id,
      owner_id: identity.owner_id,
      ...(displayName !== undefined ? { name: displayName } : {}),
    };
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // WP23 已有状态目录保存 admin credentials，但尚无 merchant-identity.json。
  // 用这份既有 principal/merchant pair 作一次迁移，避免首次 WP5 升级换身份。
  const credentialsFile = path.join(dataDir, "admin-credentials.json");
  let initialIdentity = { agent_id: profile.agent_id, owner_id: profile.owner_id };
  if (existsSync(credentialsFile)) {
    const credentials = JSON.parse(readFileSync(credentialsFile, "utf8")) as Record<string, unknown>;
    if (
      typeof credentials.principal_id !== "string" || credentials.principal_id.trim() === "" ||
      typeof credentials.merchant_id !== "string" || credentials.merchant_id.trim() === ""
    ) throw new Error("管理员凭据缺少身份字段；拒绝用新部署身份覆盖旧运行身份");
    initialIdentity = { agent_id: credentials.principal_id, owner_id: credentials.merchant_id };
  }
  const identity: PersistedMerchantIdentity = {
    schema_version: 1,
    ...initialIdentity,
    created_at: new Date().toISOString(),
    ...(profile.name !== undefined ? { display_name: profile.name } : {}),
    merchant_name_needs_update: options.merchantNameNeedsUpdate === true,
  };
  try {
    writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    return {
      ...profile,
      agent_id: initialIdentity.agent_id,
      owner_id: initialIdentity.owner_id,
    };
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    const winner = readIdentity(file);
    return { ...profile, agent_id: winner.agent_id, owner_id: winner.owner_id };
  }
}
