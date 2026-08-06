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
 * context-map — negotiation_id ↔ 远端 A2A contextId / taskId 持久化映射
 * （WP3，基线 §9.2 / §24.4–§24.5）。
 */

export { ContextMapError, ContextMapStore, contextMapFileName } from "./store.js";
export type { ContextMapErrorCode, ContextMapStoreOptions } from "./store.js";
export { parseContextMapping } from "./types.js";
export type { ContextMapping, ContextMappingPatch } from "./types.js";
