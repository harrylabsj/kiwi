import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    // Composition CI checks out the pinned sibling repositories beside Kiwi.
    // Each sibling owns its own lint configuration; do not lint their source
    // as part of Kiwi's root-level ESLint invocation.
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "kiwi-catalog/**",
      "shopping-cli/**",
      // 云端制品构建产物（scripts/build-cloud-artifact.mjs）：内含第三方包，
      // 不是本仓源码，不参与 lint。
      "build/**",
      // 本地暂存/issue 目录（工作区约定，已在 .gitignore 中）：里面可能有别的
      // 会话/任务保留的脚本产物，不是本仓源码。不忽略会让 `npm run lint` ——
      // 进而 `npm run verify` —— 在任何存有 scratch 产物的工作副本上必然失败。
      ".scratch/**",
    ],
  },
  js.configs.recommended,
  {
    // js@10 的 recommended 新增 no-useless-assignment，非项目本意约束。
    // 后续清理无用赋值后可重新开启此规则。
    rules: {
      "no-useless-assignment": "off",
    },
  },
  {
    // Preserve the published upstream file byte-for-byte. It treats absent
    // optional state files as empty and imports one unused path delimiter.
    files: [
      "integrations/hosts/workbuddy/account-assets/personal-health-advisor/0.2.8/source/workbuddy/skill/personal-health-advisor/scripts/health-advisor-mcp.mjs",
    ],
    rules: {
      "no-unused-vars": ["error", { varsIgnorePattern: "^delimiter$" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Node tooling scripts (fixture generators) run under Node directly.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["packages/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // kiwi-dsh-plugin（纯 ESM JS 插件包）在 dsh 宿主下以 Node 运行。
    files: [
      "integrations/plugins/kiwi-dsh-plugin/**/*.{js,mjs}",
      "integrations/hosts/workbuddy/**/*.mjs",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
        ecmaVersion: 2022,
      },
      globals: { ...globals.node },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  },
];
