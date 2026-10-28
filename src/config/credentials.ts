/**
 * 商家凭据的**语义归属**，集中一处，避免各处再用字段名猜。
 *
 * 一个商家实例同时握有两套互不相干的凭据：
 * - **Kiwi Catalog owner token**：登记 agent、心跳（`merchant_public.merchant_token_env`，
 *   缺省 `KIWI_MERCHANT_TOKEN`）；
 * - **shopping-cli 商家 token**：数据引擎的读写（`commerce.token_env`，事实上的
 *   协商作用域凭据）。
 *
 * 二者的 env 名字一旦重合，说明 profile 还没拆分——此时拿 `commerce.token_env`
 * 去调 shopping-cli 只会 401/403，自动轮换与子进程自证都必须直接拒绝，而不是
 * 反复重试。
 */
import type { AgentProfile } from "./profile.js";

/** Catalog owner token 的缺省 env 名（`merchant_public.merchant_token_env` 未写时）。 */
export const DEFAULT_CATALOG_OWNER_TOKEN_ENV = "KIWI_MERCHANT_TOKEN";

/** 本 profile 里 Kiwi Catalog owner token 所在的 env 名。 */
export function catalogOwnerTokenEnv(profile: AgentProfile): string {
  const declared = profile.merchant_public?.merchant_token_env;
  return declared !== undefined && declared.trim() !== "" ? declared.trim() : DEFAULT_CATALOG_OWNER_TOKEN_ENV;
}

/** shopping-cli 商家凭据所在的 env 名（协商作用域）。 */
export function shoppingTokenEnv(profile: AgentProfile): string {
  return profile.commerce.token_env;
}

/** 拆分是否完成：shopping-cli 凭据不能就是 Kiwi Catalog 的 owner token。 */
export function shoppingCredentialIsSeparate(profile: AgentProfile): boolean {
  return shoppingTokenEnv(profile) !== catalogOwnerTokenEnv(profile);
}
