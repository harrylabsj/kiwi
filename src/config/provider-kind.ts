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
 * 模型提供方判定（叶子模块，**零运行期依赖**）。
 *
 * 单独成文件的原因：`runtime/model.ts` 静态依赖 `@earendil-works/pi-ai`，
 * 而 pi-ai 会拉入 Anthropic/OpenAI/Gemini/Mistral/Bedrock 五家 SDK。云端
 * Runtime 不调用任何模型（确定性报价），却因为要判 `provider === "fake"`
 * 而被迫随制品携带整套模型 SDK（约 100 MiB）。把纯判定逻辑放到叶子模块后，
 * 云端入口的静态依赖图不再包含模型 SDK，制品可按运行时可达性裁剪。
 */

import type { AgentProfile } from "./profile.js";

export function isFakeProvider(profile: AgentProfile): boolean {
  return profile.model.provider === "fake";
}
