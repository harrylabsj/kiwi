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
 * 商家侧文档型页面（待批准、询报价、发布确认等）的统一外壳。
 *
 * 与工作台共用 {@link MERCHANT_THEME_CSS}：同一品牌头、卡片、表格和按钮，
 * 避免这些管理页各自是一套裸 HTML。`title` / `heading` / `content` 都按
 * 调用方已转义/已受控的 HTML 处理，本模块不再二次转义。
 */
import { MERCHANT_THEME_CSS } from "./theme.js";

export function renderMerchantDocPage(options: {
  title: string;
  heading: string;
  description?: string;
  content: string;
  extraCss?: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title}</title>
<style>${MERCHANT_THEME_CSS}
  body { margin: 0; padding: 0 0 64px; }
  .doc-shell { width: 100%; max-width: 1200px; margin: 0 auto; padding: 28px clamp(16px, 3vw, 40px) 0; }
  .doc-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
  .doc-head h1 { margin: 0; font-size: 24px; line-height: 1.4; font-weight: 650; }
  .doc-lead { margin: 0 0 20px; color: var(--muted); font-size: 13px; line-height: 1.8; }
  .doc-card h2 { margin: 24px 0 12px; font-size: 16px; line-height: 1.5; color: #233b2d; font-weight: 650; }
  .doc-card h2:first-child { margin-top: 0; }
  .doc-card ul { margin: 0 0 12px; padding-left: 20px; }
  .doc-card pre { margin: 0 0 12px; font: 11px ui-monospace, SFMono-Regular, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .doc-card td pre { margin: 0; max-width: 360px; }
  .doc-card td form { display: inline; }
  ${options.extraCss ?? ""}
</style>
</head>
<body>
<main class="doc-shell">
  <div class="doc-head"><div class="brand"><span class="brand-name" aria-label="Kiwi">kiwi</span><span class="brand-title">商家工作台</span></div><h1>${options.heading}</h1></div>
  ${options.description === undefined ? "" : `<p class="doc-lead">${options.description}</p>`}
  <section class="card">${options.content}</section>
</main>
</body>
</html>`;
}
