import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", ".trigger/", ".vercel/", "coverage/", "public/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Feed and API payloads are parsed from untyped JSON; typing every source
      // shape is a refactor of its own. Kept off rather than papered over.
      "@typescript-eslint/no-explicit-any": "off",
      // The verify suites count results with `ok ? pass++ : fail++`.
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true, allowShortCircuit: true }],
    },
  },
);
