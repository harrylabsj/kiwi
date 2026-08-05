/**
 * Main-conversation runtime mode (design §16).
 *
 * Reuses the operator control-plane's three modes. Writes route by mode:
 *   manual      -> advice only, never executes;
 *   supervised  -> every write creates a content-hashed ActionCandidate that
 *                  the operator must approve (/approve) before execution;
 *   autopilot   -> writes within HardPolicy auto-execute; risk escalations
 *                  still require approval.
 *
 * `supervised` is the safe default — a restart never silently widens
 * authority.
 */

export const AGENT_MODES = ["manual", "supervised", "autopilot"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const DEFAULT_AGENT_MODE: AgentMode = "supervised";

export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value);
}
