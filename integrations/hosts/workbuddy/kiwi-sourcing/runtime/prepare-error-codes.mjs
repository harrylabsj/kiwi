// Single source for preparation failure codes.
//
// buyer-session-cli writes `HOLD: <code>`; stage-runner maps that CLI code to a
// category and prefixes it with PREPARE_FAILED:; the MCP server maps the
// category to user-facing guidance. All three layers read this table so a new
// code cannot silently fall back to a generic message in only one of them.

// CLI code (or error message) -> category surfaced to the host.
export const PREPARE_CODE_CATEGORIES = new Map([
  ['CACHE_BUSY', 'CACHE_BUSY'],
  ['CACHE_POINTER_INVALID', 'CACHE_STATE_INVALID'],
  ['CACHE_DIRECTORY_INVALID', 'CACHE_STATE_INVALID'],
  ['CACHE_STATE_INVALID', 'CACHE_STATE_INVALID'],
  ['CACHE_LEGACY_STATE_REQUIRES_REVIEW', 'CACHE_STATE_INVALID'],
  ['CACHE_TARBALL_INVALID', 'CACHE_STATE_INVALID'],
  ['ATTESTATION_FETCH_FAILED', 'REGISTRY_UNAVAILABLE'],
  ['ATTESTATION_INVALID', 'ATTESTATION_INVALID'],
  ['PROVENANCE_MISSING', 'PROVENANCE_MISSING'],
  ['LATEST_METADATA_UNAVAILABLE', 'REGISTRY_UNAVAILABLE'],
  ['REGISTRY_TIMEOUT', 'REGISTRY_UNAVAILABLE'],
  ['REGISTRY_HTTP_ERROR', 'REGISTRY_UNAVAILABLE'],
  ['ISOLATED_INSTALL_FAILED', 'INSTALL_FAILED'],
  ['AUDIT_FAILED', 'PROVENANCE_FAILED'],
  ['SIGNATURE_VERIFIER_UNAVAILABLE', 'SIGNATURE_VERIFIER_UNAVAILABLE'],
  ['SIGNER_POLICY_VERIFICATION_FAILED', 'SIGNER_POLICY_VERIFICATION_FAILED'],
  ['TREE_INSPECTION_FAILED', 'TREE_CHECK_FAILED'],
  ['TREE_RECHECK_FAILED', 'TREE_CHECK_FAILED'],
  // A probe timeout or a probe process that died is not a tool contract
  // mismatch: it can succeed on retry and must not tell the user the expert or
  // runtime version is wrong.
  ['MCP_PROBE_FAILED', 'TOOL_CHECK_RETRYABLE'],
  ['MCP_PROBE_TIMEOUT', 'TOOL_CHECK_RETRYABLE'],
  ['MCP_SPAWN_FAILED', 'TOOL_CHECK_RETRYABLE'],
  ['MCP_IDENTITY_UNSUPPORTED', 'IDENTITY_CAPABILITY_MISSING'],
  ['TOOL_SET_MISMATCH', 'TOOL_CHECK_FAILED'],
  ['TOOL_SCHEMA_MISMATCH', 'TOOL_CHECK_FAILED'],
  ['VERSION_DOWNGRADE', 'VERSION_REJECTED'],
  ['LATEST_CHANGED_STAGE_REQUIRED', 'VERSION_REJECTED'],
  ['LATEST_RESOLUTION_EXPIRED', 'VERSION_REJECTED'],
]);

// Category (with the PREPARE_FAILED: prefix) -> guidance shown to the user.
export const PREPARE_ERROR_MESSAGES = new Map([
  ['PREPARE_FAILED:CACHE_BUSY', 'KIWI_PREPARE_CACHE_BUSY: Another Kiwi preparation is updating the runtime cache. Keep the connection open and retry shortly; the procurement request was not sent.'],
  ['PREPARE_FAILED:CACHE_STATE_INVALID', 'KIWI_PREPARE_CACHE_STATE_INVALID: Incomplete or invalid cache needs review; no package was run.'],
  ['PREPARE_FAILED:REGISTRY_UNAVAILABLE', 'KIWI_PREPARE_REGISTRY_UNAVAILABLE: Cannot reach the official npm registry or its attestation endpoint; verify network access and reconnect.'],
  ['PREPARE_FAILED:INSTALL_FAILED', 'KIWI_PREPARE_INSTALL_FAILED: Kiwi dependencies could not be installed. The procurement request was not sent.'],
  ['PREPARE_FAILED:PROVENANCE_FAILED', 'KIWI_PREPARE_PROVENANCE_FAILED: Package provenance verification failed; no package was run.'],
  ['PREPARE_FAILED:TREE_CHECK_FAILED', 'KIWI_PREPARE_TREE_CHECK_FAILED: The installed Kiwi runtime files changed during verification; no package was run. Reconnect and retry once; report it if it repeats.'],
  ['PREPARE_FAILED:TOOL_CHECK_FAILED', 'KIWI_PREPARE_TOOL_CHECK_FAILED: The Kiwi runtime did not pass the MCP tool contract check. Check the expert and runtime versions before retrying. The procurement request was not sent.'],
  ['PREPARE_FAILED:TOOL_CHECK_RETRYABLE', 'KIWI_PREPARE_TOOL_CHECK_RETRYABLE: The Kiwi runtime probe did not complete (timeout or process failure). Keep the connection open and retry; the procurement request was not sent.'],
  ['PREPARE_FAILED:IDENTITY_CAPABILITY_MISSING', 'KIWI_PREPARE_IDENTITY_CAPABILITY_MISSING: The Kiwi runtime does not expose the required identity capability. Check the expert and runtime versions before retrying.'],
  ['PREPARE_FAILED:VERSION_REJECTED', 'KIWI_PREPARE_VERSION_REJECTED: The available Kiwi runtime version is older or changed unexpectedly. Reconnect so the latest version is resolved again; the procurement request was not sent.'],
  ['PREPARE_FAILED:ATTESTATION_INVALID', 'KIWI_PREPARE_FAILED:ATTESTATION_INVALID: Package provenance verification failed; no package was run.'],
  ['PREPARE_FAILED:PROVENANCE_MISSING', 'KIWI_PREPARE_FAILED:PROVENANCE_MISSING: Package provenance verification failed; no package was run.'],
  ['PREPARE_FAILED:SIGNATURE_VERIFIER_UNAVAILABLE', 'KIWI_PREPARE_FAILED:SIGNATURE_VERIFIER_UNAVAILABLE: Package provenance verification failed; no package was run.'],
  ['PREPARE_FAILED:SIGNER_POLICY_VERIFICATION_FAILED', 'KIWI_PREPARE_FAILED:SIGNER_POLICY_VERIFICATION_FAILED: Package provenance verification failed; no package was run.'],
  ['NPM_12_UNAVAILABLE', 'NPM_12_UNAVAILABLE: Kiwi requires npm 12. Install or upgrade npm to version 12, ensure it is on PATH, then reconnect and retry.'],
]);

// Normalize the hold code a CLI writes to stderr. Tool-name details are
// stripped. Any TOOL_SCHEMA_MISMATCH prefix keeps its terminal classification:
// future tool names may contain digits or other characters, and a malformed
// suffix must not downgrade a real contract mismatch to a generic error.
export function holdCode(message) {
  return /^TOOL_SCHEMA_MISMATCH:/.test(message)
    ? 'TOOL_SCHEMA_MISMATCH'
    : /^[A-Z_]{3,80}$/.test(message) ? message : 'BUYER_INSPECTION_FAILED';
}
