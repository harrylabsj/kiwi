// Schema compatibility is necessary but is not evidence of authorization semantics.
const names = ['kiwi_search','kiwi_request_quotes','kiwi_get_task','kiwi_negotiate','kiwi_accept_agreement','kiwi_get_agreement','kiwi_handoff','kiwi_approve','kiwi_reject','kiwi_follow_merchant','kiwi_unfollow_merchant','kiwi_list_follows','kiwi_get_follow_updates'];
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
function normalize(tools) {
  if (!Array.isArray(tools) || tools.length !== names.length) throw new Error('TOOL_SET_MISMATCH');
  const map = new Map();
  for (const tool of tools) {
    if (!names.includes(tool?.name) || map.has(tool.name) || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) throw new Error('TOOL_SET_MISMATCH');
    map.set(tool.name, JSON.stringify(canonical(tool.inputSchema)));
  }
  return map;
}
export function enableQuoteHistory(baseline) {
  const properties = baseline.find(tool => tool?.name === 'kiwi_request_quotes')?.inputSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('TOOL_BASELINE_INVALID');
  }
  properties.reuse_history = { type: 'boolean' };
}

export function checkToolContract(baseline, candidate) {
  if (!Array.isArray(baseline) || !Array.isArray(candidate)) throw new Error('TOOL_SET_MISMATCH');
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
  const properties = normalizedCandidate.find(tool => tool.name === 'kiwi_request_quotes')?.inputSchema?.properties;
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
  const a=normalize(baseline), b=normalize(normalizedCandidate);
  for (const name of names) if (a.get(name)!==b.get(name)) throw new Error(`TOOL_SCHEMA_MISMATCH:${name}`);
  return true;
}
