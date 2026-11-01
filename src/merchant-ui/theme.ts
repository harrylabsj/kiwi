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
 * 商家侧页面共用的视觉主题（工作台 / 管理员登录 / 待批准命令）。
 *
 * 单文件静态壳、零构建：所有页面内联同一份 CSS 常量，避免登录页、确认页
 * 与工作台各写一套样式而漂移。只放**通用**令牌与组件；工作台的布局
 * （body 网格、侧栏、页头）、表格列宽等页面专属规则留在各自模板里。
 */
export const MERCHANT_THEME_CSS = `
  :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #23342d; background: #f5f7f4; font-size: 14px; line-height: 1.6; --kiwi: #205c43; --border: #dce4de; --muted: #5e7066; }
  * { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; }
  button, a, input, select, textarea { -webkit-tap-highlight-color: transparent; }
  a { color: var(--kiwi); text-underline-offset: 3px; }
  button { cursor: pointer; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  :focus-visible { outline: 3px solid #9b7214; outline-offset: 3px; }
  .brand { display: flex; align-items: center; gap: 16px; }
  .brand-name { color: var(--kiwi); font-size: 30px; font-weight: 750; letter-spacing: -1.6px; line-height: 1; }
  .brand-title { font-size: 14px; font-weight: 600; padding-left: 16px; border-left: 1px solid var(--border); }
  .card { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 3px 12px #243b2b04; min-width: 0; }
  .card h2 { font-size: 16px; line-height: 1.5; margin: 0 0 18px; color: #233b2d; font-weight: 650; }
  .card p { margin: 12px 0; overflow-wrap: anywhere; }
  .card > :last-child { margin-bottom: 0; }
  .table-scroll { width: 100%; overflow-x: auto; border: 1px solid #e4eae5; border-radius: 8px; margin: 12px 0 18px; }
  table { width: 100%; min-width: 620px; border-collapse: collapse; font-size: 13px; line-height: 1.6; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #e9eee9; vertical-align: middle; }
  th { color: #53665b; font-weight: 600; white-space: nowrap; background: #f7f9f6; }
  tr:last-child > th, tr:last-child > td { border-bottom: 0; }
  tr:hover > td { background: #fafcf9; }
  .act { display: inline-flex; align-items: center; justify-content: center; border: 1px solid #c8d5cc; background: #fff; color: #344c3d; border-radius: 7px; padding: 8px 14px; min-height: 38px; text-decoration: none; font-size: 13px; font-weight: 550; line-height: 1.5; }
  .act:hover { background: #f4f8f3; border-color: #8ba695; }
  .act.primary { background: var(--kiwi); color: #fff; border-color: var(--kiwi); }
  .act.primary:hover { background: #164a34; }
  .act.danger { color: #a03933; border-color: #e5c2bd; }
  .act.danger:hover { background: #fff4f2; }
  textarea, input[type=text], input[type=password] { width: 100%; max-width: 100%; border: 1px solid #c8d5cc; border-radius: 7px; padding: 10px 12px; color: #23342d; background: #fcfdfb; font: 13px ui-monospace, SFMono-Regular, monospace; line-height: 1.6; }
  textarea { resize: vertical; }
  input::placeholder, textarea::placeholder { color: #69796e; }
  input[type=file] { min-width: 0; max-width: 100%; border: 1px dashed #b4c9b9; border-radius: 8px; padding: 10px; background: #f7faf5; font-size: 13px; }
  input[type=file]::file-selector-button { border: 1px solid #c8d5cc; border-radius: 5px; background: #fff; color: #344c3d; padding: 6px 10px; margin-right: 10px; cursor: pointer; }
  input[type=checkbox] { accent-color: var(--kiwi); width: 16px; height: 16px; vertical-align: middle; }
  .muted { color: var(--muted); font-size: 12px; line-height: 1.8; }
  label { font-size: 13px; }
  select { border: 1px solid #c8d5cc; border-radius: 7px; padding: 8px 12px; font-size: 13px; color: #23342d; background: #fff; max-width: 100%; }
  .login-card { max-width: 600px; padding: 32px; }
  .empty-state { padding: 24px 16px; background: #f8faf6; border: 1px dashed #d5e1d5; border-radius: 8px; }
  @media (max-width: 640px) {
    .card, .login-card { padding: 20px 16px; border-radius: 10px; margin-bottom: 16px; }
    .card h2 { font-size: 15px; margin-bottom: 14px; }
  }
  @media (prefers-reduced-motion: no-preference) { .act { transition: background-color .15s, border-color .15s; } }
`;
