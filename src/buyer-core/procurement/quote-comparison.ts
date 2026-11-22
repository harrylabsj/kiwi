import { normalizeCosts } from "./quote-normalizer.js";
import { asRecord, conditionMatches, isProjectable, type Basis, validTimestamp } from "./requirements.js";
import { missingBasis, type Observation } from "./source-observation.js";

const productKinds = new Set(["specification", "condition", "packaging"]);

function evaluate(basis: Basis, observation: Observation) {
  const { source, evidence, product, response } = observation;
  const nativeResponse = response?.schema_version === 1 && response.request_projection_digest === observation.projection_digest && observation.projection_digest
    ? response : undefined;
  const responses = Array.isArray(nativeResponse?.requirements) ? nativeResponse.requirements.map(asRecord) : [];
  const evidenceRef = (field: string) => ({ source_ref: evidence.reference, field, observed_at: evidence.captured_at, version: observation.digest });
  const requirements = basis.requirements.map(requirement => {
    const answers = responses.filter(answer => answer.requirement_id === requirement.id);
    const answer = answers.length === 1 ? answers[0] : undefined;
    const commercialValue = nativeResponse ? ((answer?.status === "confirmed" || answer?.status === "deviation") && typeof answer.source_version === "string" ? answer.value : undefined) :
      observation.verified && source.channel === "ecommerce" ? product?.values?.[requirement.id] : undefined;
    const actual = productKinds.has(requirement.kind) ? commercialValue ?? product?.values?.[requirement.id] : commercialValue;
    const confirmed = answers.length > 1 ? "CONFLICT" : actual === undefined ? "UNKNOWN" :
      conditionMatches(requirement, actual) ? "MET" : "NOT_MET";
    return { id: requirement.id, requested: requirement.value, hardness: requirement.hardness,
      transmitted: isProjectable(requirement) && observation.projection_digest ? observation.transmission : "NOT_SENT",
      confirmed, value: actual, evidence: actual !== undefined ? evidenceRef(requirement.id) : undefined };
  });
  const hardProduct = requirements.filter(result => result.hardness === "hard" && basis.requirements.some(r => r.id === result.id && productKinds.has(r.kind)));
  const modelSame = !!basis.model && product?.model?.trim().toUpperCase() === basis.model.trim().toUpperCase();
  const modelConflict = !!basis.model && !!product?.model && !modelSame;
  const matching = hardProduct.some(result => result.confirmed === "NOT_MET") || (basis.selection_mode === "exact_item" && modelConflict) ? "ALTERNATIVE" :
    hardProduct.some(result => result.confirmed !== "MET") ? "UNVERIFIED" :
    modelSame ? "SAME_ITEM" :
    basis.selection_mode === "spec_based" && hardProduct.length ? "MEETS_SPEC" : "UNVERIFIED";
  const costs = normalizeCosts(observation.costs, basis.quantity, basis.unit, observation.native_item);
  const budget = basis.budget;
  const cap = budget ? BigInt(budget.amount_minor) * BigInt(budget.scope === "unit" ? basis.quantity ?? 0 : 1) : undefined;
  const pageOrImport = observation.price_kind === "PAGE_REFERENCE" || observation.price_kind === "IMPORTED_REFERENCE";
  const cash = pageOrImport ? null : costs.cash_total_minor;
  const hypothetical = pageOrImport ? costs.cash_total_minor ?? costs.known_amount_minor : null;
  const budgetStatus = !budget ? "not_provided" : cash === null || (budget.scope === "unit" && basis.quantity === undefined) ? "unknown" :
    BigInt(cash) > cap! ? "exceeds" : "within";
  const arrival = nativeResponse?.arrives_by ?? product?.arrived_by;
  const nativeDelivery = asRecord(observation.native_fulfillment).delivery_before;
  const destination = nativeResponse?.destination ?? product?.destination;
  const confirmedQuantity = nativeResponse?.available_quantity ?? product?.stock_quantity;
  const missing = [...costs.missing, ...costs.conflicts,
    ...requirements.filter(r => r.confirmed !== "MET" && r.hardness === "hard").map(r => `requirement:${r.id}:${r.confirmed}`)];
  if (basis.delivery_before && (!validTimestamp(arrival) || Date.parse(arrival) > Date.parse(basis.delivery_before))) missing.push("arrival_deadline");
  if (nativeResponse && validTimestamp(arrival) && validTimestamp(nativeDelivery) &&
      Date.parse(arrival) !== Date.parse(nativeDelivery)) missing.push("delivery_terms_conflict");
  if (basis.destination && destination !== basis.destination) missing.push("delivery_destination");
  if (basis.quantity !== undefined && !(typeof confirmedQuantity === "number" && Number.isSafeInteger(confirmedQuantity) &&
      confirmedQuantity >= basis.quantity)) missing.push("available_quantity");
  if (response && Object.keys(response).length && !nativeResponse) missing.push("projection_digest_mismatch");
  if (matching === "UNVERIFIED" || matching === "ALTERNATIVE") missing.push("item_matching");
  if (observation.expired) missing.push("freshness");
  if (basis.budget?.hardness === "hard" && budgetStatus !== "within") missing.push("hard_budget");
  const formal = observation.verified && (observation.price_kind === "KNP_OFFER" ? observation.native_current === true : validTimestamp(evidence.valid_until));
  if (observation.verified && !formal) missing.push("formal_valid_until");
  const group = formal
    ? (missing.length === 0 && cash !== null && !observation.expired ? "CONFIRMED" : "INCOMPLETE")
    : "REFERENCE";
  const questions = [...new Set(missing.filter(field => field !== "hard_budget"))].map(field => ({
    source_id: source.id, offer_digest: observation.digest, field,
  }));
  return { source_id: source.id, supplier: source.name, supplier_ref: product?.supplier_ref, channel: source.channel,
    variant: source.variant, price_kind: observation.price_kind, offer_digest: observation.digest,
    evidence, field_evidence: { price: evidenceRef("costs"), match: evidenceRef("product"), delivery: evidenceRef("delivery") },
    matching, requirements, ...costs, cash_total_minor: cash, conditional_amount_minor: hypothetical,
    known_amount_minor: pageOrImport ? null : costs.known_amount_minor, missing, group, questions, budget: budgetStatus,
    budget_excess_minor: budgetStatus === "exceeds" ? Number(BigInt(cash!) - cap!) : undefined };
}

export function compareQuotes(basis: Basis, observations: Observation[]) {
  const mapped = new Map<string, Set<string>>();
  for (const observation of observations) {
    const { supplier_ref: supplier, verified_kiwi_merchant_id: merchant } = observation.product ?? {};
    if (observation.price_kind !== "SUPPLIER_QUOTE" || !observation.verified || !supplier || !merchant) continue;
    const suppliers = mapped.get(merchant) ?? new Set<string>();
    suppliers.add(supplier);
    mapped.set(merchant, suppliers);
  }
  const rows = observations.map(observation => {
    const merchant = observation.source.merchant_id;
    const identities = merchant ? mapped.get(merchant) : undefined;
    const supplier = identities?.size === 1 ? [...identities][0] : undefined;
    return evaluate(basis, supplier ? { ...observation, product: { ...observation.product, supplier_ref: supplier } } : observation);
  });
  const eligible = rows.filter(row => row.group === "CONFIRMED")
    .sort((a, b) => a.cash_total_minor! - b.cash_total_minor! || a.source_id.localeCompare(b.source_id));
  const distinct = new Set(eligible.map(row => row.supplier_ref).filter(Boolean)).size;
  const requirements = missingBasis(basis);
  const coverageInsufficient = basis.minimum_suppliers !== undefined && distinct < basis.minimum_suppliers;
  return { rows, requirements, independent_suppliers_confirmed: distinct,
    supplier_identity_unknown: rows.some(row => !row.supplier_ref),
    coverage_insufficient: coverageInsufficient,
    recommendation: !requirements.length && !coverageInsufficient ? eligible[0]?.source_id ?? null : null,
    eligible: eligible.map(row => row.source_id),
    questions: rows.flatMap(row => row.questions) };
}
