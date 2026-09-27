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
 * Shared tool typing for kiwi's agent tools (pi-agent-core 0.87).
 *
 * `AgentHarnessTool` (the harness-native shape) requires all six `execute`
 * parameters at call sites, but every kiwi tool only implements
 * `(toolCallId, params)`. `KiwiTool` keeps the harness identity fields and
 * narrows `execute` to the two parameters kiwi actually uses (plus the
 * optional streaming callback), so tools and tests can use the short form
 * while the adapter in `kernel.ts` still forwards the harness-shaped call.
 */
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";

type HarnessExecute = AgentHarnessTool<undefined>["execute"];
type HarnessParams = Parameters<HarnessExecute>[1];
type HarnessUpdate = Parameters<HarnessExecute>[2];

export type KiwiTool = Omit<AgentHarnessTool<undefined>, "execute"> & {
  execute(
    toolCallId: string,
    params: HarnessParams,
    onUpdate?: HarnessUpdate,
  ): Promise<AgentToolResult<unknown>>;
};
