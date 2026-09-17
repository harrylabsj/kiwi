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
 * URL 规范化小工具。
 *
 * `value.replace(/\/+$/, "")` 看着是 O(N)，但正则引擎会在**每个起始位置**重试一次，
 * 遇到长尾斜杠串时退化成 O(N²)（CodeQL `js/polynomial-redos`）。这里改成一次线性
 * 扫描，语义与原来完全一致：去掉末尾连续斜杠，全斜杠输入得到空串。
 *
 * 调用方多是运维配置里的 baseUrl，实际不可达；但"输入长度不可控"是一般性问题，
 * 统一用线性写法收口，不依赖"调用方保证输入不长"。
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
