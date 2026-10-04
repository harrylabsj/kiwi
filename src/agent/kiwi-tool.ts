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
 * Shared tool typing for kiwi's agent tools (pi-agent-core 1.0).
 *
 * pi 1.0 removed the harness-native `AgentHarnessTool` shape (A94); the runtime
 * `AgentTool` is now the only tool type. `KiwiTool` keeps the identity fields
 * and narrows `execute` to the parameters kiwi actually uses
 * `(toolCallId, params)` plus the optional streaming callback, so tools and
 * tests can use the short form while the adapter in `kernel.ts` forwards the
 * runtime-shaped call.
 */
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

type HarnessParams = Parameters<AgentTool["execute"]>[1];
type HarnessUpdate = AgentToolUpdateCallback<unknown>;

export type KiwiTool = Omit<AgentTool, "execute"> & {
  execute(
    toolCallId: string,
    params: HarnessParams,
    onUpdate?: HarnessUpdate,
  ): Promise<AgentToolResult<unknown>>;
};
