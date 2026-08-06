/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Main-conversation runtime mode (design §16).
 *
 * Reuses the operator control-plane's three modes. Writes route by mode:
 *   manual      -> advice only, never executes;
 *   supervised  -> every write creates a content-hashed WriteApprovalCandidate that
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
