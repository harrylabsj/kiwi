// Schema compatibility is necessary but is not evidence of authorization semantics.
const legacyNames = ['kiwi_search','kiwi_request_quotes','kiwi_get_task','kiwi_negotiate','kiwi_accept_agreement','kiwi_get_agreement','kiwi_handoff','kiwi_approve','kiwi_reject','kiwi_follow_merchant','kiwi_unfollow_merchant','kiwi_list_follows','kiwi_get_follow_updates'];
const companyNames = [...legacyNames, 'kiwi_prepare_procurement', 'kiwi_get_procurement', 'kiwi_compare_quotes', 'kiwi_get_comparison'];
export function toolNames(profile = 'legacy13') {
  if (profile === 'legacy13') return legacyNames;
  if (profile === 'company-procurement-v1') return companyNames;
  throw new Error('INVALID_BUYER_TOOL_PROFILE');
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
// Only fixed reason codes and names from the selected profile enter diagnostics.
function setMismatch(reason, knownName) {
  const error = new Error('TOOL_SET_MISMATCH');
  error.contractDetail = knownName ? `${reason}:${knownName}` : reason;
  return error;
}
function normalize(tools, names) {
  if (!Array.isArray(tools)) throw setMismatch('EXPECTED_LIST');
  const map = new Map();
  for (const tool of tools) {
    if (!names.includes(tool?.name)) throw setMismatch('UNKNOWN_TOOL');
    if (map.has(tool.name)) throw setMismatch('DUPLICATE_TOOL', tool.name);
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
      throw setMismatch('INVALID_SCHEMA', tool.name);
    }
    map.set(tool.name, JSON.stringify(canonical(tool.inputSchema)));
  }
  for (const name of names) if (!map.has(name)) throw setMismatch('MISSING_TOOL', name);
  return map;
}
// Embedded buyers pin these additive parameters. Older standalone buyers keep their frozen baseline.
const negotiationInputs = {
  candidate_id: { type: 'string', minLength: 1 },
  target_unit_price: {
    type: 'object', additionalProperties: false, required: ['currency', 'amount_minor'],
    properties: { currency: { type: 'string', pattern: '^[A-Z]{3}$' }, amount_minor: { type: 'integer', minimum: 1 } },
  },
};
export function enableTargetedNegotiation(baseline, locale = 'en') {
  const tool = baseline.find(tool => tool.name === 'kiwi_negotiate');
  const properties = tool?.inputSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw setMismatch('INVALID_SCHEMA', 'kiwi_negotiate');
  tool.description = locale === 'zh'
    ? '多候选任务必须指定 candidate_id。已授权的还价用 target_unit_price 传递，与核实的报价币种一致。预算仅作为上限。'
    : 'Select candidate_id for a multi-candidate task. Use target_unit_price for an authorized price in the verified currency. The budget is a ceiling.';
  Object.assign(properties, structuredClone(negotiationInputs));
}

export function enableQuoteHistory(baseline) {
  const properties = baseline.find(tool => tool?.name === 'kiwi_request_quotes')?.inputSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('TOOL_BASELINE_INVALID');
  }
  properties.reuse_history = { type: 'boolean' };
}

export function checkToolContract(baseline, candidate, profile) {
  const names = toolNames(profile);
  const a = normalize(baseline, names);
  if (!Array.isArray(candidate)) throw setMismatch('EXPECTED_LIST');
  const normalizedCandidate = structuredClone(candidate);
  const region = normalizedCandidate.find(tool => tool?.name === 'kiwi_search')?.inputSchema?.properties?.region;
  const baselineRegion = baseline.find(tool => tool?.name === 'kiwi_search')?.inputSchema?.properties?.region;
  if (region?.type === 'string' && region.deprecated === true &&
      typeof region.description === 'string' && baselineRegion?.deprecated === undefined &&
      baselineRegion?.description === undefined) {
    // The old WorkBuddy connector still accepts the optional region string.
    delete region.deprecated;
    delete region.description;
  }
  const historyIsRequired = baseline.find(tool => tool.name === 'kiwi_request_quotes')?.inputSchema?.properties?.reuse_history !== undefined;
  const properties = normalizedCandidate.find(tool => tool?.name === 'kiwi_request_quotes')?.inputSchema?.properties;
  const history = properties?.reuse_history;
  if (history !== undefined && history?.type === 'boolean' &&
      Object.keys(history).some(key => key !== 'type' && key !== 'description')) {
    throw new Error('TOOL_SCHEMA_MISMATCH:kiwi_request_quotes');
  }
  if (!historyIsRequired && history?.type === 'boolean') {
    delete properties.reuse_history;
  } else if (historyIsRequired && properties?.reuse_history?.type === 'boolean') {
    // Descriptions vary by client locale. All structural constraints are still compared.
    delete properties.reuse_history.description;
  }
  const b=normalize(normalizedCandidate,names);
  for (const name of names) if (a.get(name)!==b.get(name)) throw new Error(`TOOL_SCHEMA_MISMATCH:${name}`);
  return true;
}
