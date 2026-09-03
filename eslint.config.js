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
    // Node tooling scripts (fixture generators) run under Node directly.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // kiwi-dsh-plugin（纯 ESM JS 插件包）在 dsh 宿主下以 Node 运行。
    files: ["integrations/plugins/kiwi-dsh-plugin/**/*.{js,mjs}"],
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
