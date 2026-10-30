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
export function checkToolContract(baseline, candidate) {
  const a=normalize(baseline), b=normalize(candidate);
  for (const name of names) if (a.get(name)!==b.get(name)) throw new Error(`TOOL_SCHEMA_MISMATCH:${name}`);
  return true;
}
