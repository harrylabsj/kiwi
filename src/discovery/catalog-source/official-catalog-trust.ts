/** Public trust anchor for the official Kiwi Catalog, verified via operator SSH.
 * Unknown issuers remain rejected; key rotation requires a signed update or a
 * new release rather than trusting a key supplied by a merchant's record.
 */
import type { BindingTrustStore } from "../../trust/binding/verify.js";

const OFFICIAL_ORIGIN = "https://catalog.kiwi.harrylabsj.com";
const ISSUER_KID = "kiwi-catalog-issuer-20261001-01";
const ISSUER_KEY = Object.freeze({ kty: "OKP", crv: "Ed25519", x: "LCQI4esTW_H7IPwIMzj0q5Xq5BdaaP5ne0Pvgue_yKk" });

/** Custom catalogs need their operator-supplied trust store, not a buyer login. */
export function officialCatalogTrust(origin: string): BindingTrustStore | undefined {
  if (origin !== OFFICIAL_ORIGIN) return undefined;
  return { resolveIssuerKey: (kid) => kid === ISSUER_KID ? ISSUER_KEY : undefined };
}
