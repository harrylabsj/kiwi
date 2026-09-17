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
 * 原子文件写入（tmp + rename）：读者要么看到旧内容要么看到新内容，绝不读到
 * 半截 JSON（审查 P2：capability-probe.json / health.json 非原子写在并发读下
 * 产生撕裂读 → 假 critical 告警；与 policy-runtime 的原子写同一范式）。
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function writeFileAtomic(
  file: string,
  data: string,
  options: { mode?: number } = {},
): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode: options.mode ?? 0o600 });
  renameSync(tmp, file);
}
