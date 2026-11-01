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
 * 商家侧所有页面共用一个视觉主题。
 *
 * 工作台页面（page.ts）必须保持自包含（verify:browser-artifact 禁止模块
 * 导入），因此它内联同一份令牌；其余 Node 侧页面导入 `MERCHANT_THEME_CSS`。
 * 这里锁住两边共用的关键令牌，避免只改一处造成页面风格漂移。
 */
import { describe, expect, it } from "vitest";

import { renderAdminLoginPage } from "../src/auth/merchant-sessions.js";
import { renderMerchantManagementPage } from "../src/http/merchant-management/page.js";
import { renderPendingPage } from "../src/merchant-admin/pending-page.js";
import { MERCHANT_THEME_CSS } from "../src/merchant-ui/theme.js";

const TOKENS = [
  "--kiwi: #205c43",
  "--border: #dce4de",
  "--muted: #5e7066",
  "font-family: -apple-system",
  ".brand-name { color: var(--kiwi);",
  ".card { background: #fff; border: 1px solid var(--border);",
  ".act.primary { background: var(--kiwi); color: #fff;",
  "input[type=checkbox] { accent-color: var(--kiwi);",
  ".login-card { max-width: 600px;",
];

describe("merchant pages share one visual theme", () => {
  it("workbench stays self-contained and keeps the shared tokens", () => {
    const workbench = renderMerchantManagementPage();
    expect(workbench).not.toContain("MERCHANT_THEME_CSS");
    for (const token of TOKENS) {
      expect(workbench).toContain(token);
      expect(MERCHANT_THEME_CSS).toContain(token);
    }
  });

  it("login page embeds the shared theme", () => {
    const login = renderAdminLoginPage({});
    for (const token of TOKENS) expect(login).toContain(token);
    expect(login).toContain('class="card login-card"');
    expect(login).toContain('class="act primary"');
  });

  it("pending page embeds the shared theme", () => {
    const pending = renderPendingPage("测试商家", []);
    for (const token of TOKENS) expect(pending).toContain(token);
    expect(pending).toContain('class="brand-name"');
    expect(pending).toContain('class="empty-state"');
  });
});
