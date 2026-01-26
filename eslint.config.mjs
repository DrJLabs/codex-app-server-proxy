import js from "@eslint/js";
import globals from "globals";
import playwright from "eslint-plugin-playwright";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import { FlatCompat } from "@eslint/eslintrc";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });
const pwRecommended = playwright.configs?.["flat/recommended"] ?? {};
const testGlobals = {
  describe: "readonly",
  it: "readonly",
  test: "readonly",
  expect: "readonly",
  beforeAll: "readonly",
  afterAll: "readonly",
};
const commonTestRules = {
  // Keep prior behavior from legacy config
  "promise/param-names": "off",
  "n/no-unsupported-features/node-builtins": "off",
  "no-constant-condition": "off",
  "vitest/no-conditional-expect": "off",
  "vitest/no-standalone-expect": "off",
};
const tsFilePatterns = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

export default [
  {
    ignores: [
      "web-bundles/**",
      "playwright-report/**",
      "test-results/**",
      ".codev/**",
      ".codex-api/**",
      "bmad/**",
      ".bmad/**",
      "bmad-bak/**",
      "external/**",
      "docs/_archive/**",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  // Bring back plugin recommended sets from legacy extends via compat
  ...compat.extends(
    "plugin:import/recommended",
    "plugin:n/recommended",
    "plugin:promise/recommended"
  ),
  {
    name: "base",
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    settings: {
      "import/resolver": {
        node: {
          extensions: [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".json"],
        },
      },
      "import/core-modules": ["vitest/config"],
    },
    // Pull in security ruleset for flat config by spreading the rules directly,
    // then soften a few high-noise rules. Keep plugin registered for rule IDs.
    plugins: { security },
    rules: {
      ...(security.configs?.recommended?.rules || {}),
      "no-console": "off",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-empty": "off",
      "no-control-regex": "off",
      "import/order": "off",
      "n/no-unsupported-features/es-syntax": "off",
      "n/no-process-exit": "off",
      "n/hashbang": "off",
      // Keep major security rules as errors globally; disable inline with reasoning per occurrence
      "security/detect-child-process": "error",
      "security/detect-non-literal-regexp": "error",
      "security/detect-object-injection": "error",
      "security/detect-non-literal-fs-filename": "error",
      "security/detect-unsafe-regex": "error",
    },
  },
  // TypeScript (non-type-checked) linting
  {
    name: "typescript",
    files: tsFilePatterns,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    settings: {
      "import/resolver": {
        node: {
          extensions: [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".json"],
        },
      },
      "import/core-modules": ["vitest/config"],
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-redeclare": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-redeclare": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "n/no-missing-import": "off",
    },
  },
  // Vitest + integration tests (non-Playwright)
  {
    name: "vitest-and-integration",
    files: ["tests/unit/**/*.{js,ts}", "tests/integration/**/*.{js,ts}"],
    languageOptions: {
      globals: { ...testGlobals },
    },
    plugins: { vitest },
    rules: {
      ...(vitest.configs?.recommended?.rules || {}),
      "vitest/valid-expect": "off",
      ...commonTestRules,
    },
  },
  // Playwright E2E tests only
  {
    ...pwRecommended,
    name: "playwright-e2e",
    // Restrict Playwright rules to top-level specs only (not unit/*.spec.js)
    files: ["tests/*.spec.js", "tests/e2e/**/*.spec.js"],
    languageOptions: {
      ...(pwRecommended.languageOptions || {}),
      globals: {
        ...(pwRecommended.languageOptions?.globals || {}),
        ...testGlobals,
      },
    },
    rules: {
      ...(pwRecommended.rules || {}),
      ...commonTestRules,
      // mirror prior config: allow conditionals in tests
      "playwright/no-conditional-in-test": "off",
    },
  },
  // Keep Prettier as the last config to disable stylistic ESLint rules
  ...compat.extends("prettier"),
];
