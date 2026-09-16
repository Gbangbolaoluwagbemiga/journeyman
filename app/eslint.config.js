import js from "@eslint/js";
import globals from "globals";
import reactDOM from "eslint-plugin-react-dom";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import reactX from "eslint-plugin-react-x";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
  globalIgnores([
    "dist",
    "packages",
    "src/contracts/*",
    "!src/contracts/util.ts",
    // Out-of-app trees with their own tooling/tsconfigs:
    "backend/**",
    "contracts/**",
    "subgraph/**",
    "scripts/**",
    // Vitest suite — not part of tsconfig.app.json's build, has its own
    // vitest.config.ts instead.
    "test/**",
    "vitest.config.ts",
  ]),
  {
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      reactDOM.configs.recommended,
      reactHooks.configs["recommended-latest"],
      reactRefresh.configs.vite,
      reactX.configs["recommended-typescript"],
      prettier,
    ],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        project: [
          "./tsconfig.node.json",
          "./tsconfig.app.json",
          // Without this the whole e2e suite fails to parse, and eslint reports
          // that as six errors rather than as "these files were never linted".
          "./tsconfig.e2e.json",
        ],
        tsconfigRoot: import.meta.dirname,
      },
    },
    rules: {
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-imports": "off",
      "no-unused-vars": "off",
      // Web3 codebase: contract ABIs/wagmi types are intentionally dynamic.
      // These rules from recommendedTypeChecked produce thousands of false
      // positives against generated types and any-typed transport layers.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/only-throw-error": "off",
      "no-empty": "off",
      "no-useless-escape": "off",
      "no-control-regex": "off",
      "no-prototype-builtins": "off",
      "no-case-declarations": "off",
      "prefer-const": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "react-x/no-nested-component-definitions": "off",
    },
  }
);
