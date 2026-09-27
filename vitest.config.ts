import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// src/config.ts holds personal profile data and is gitignored. Tests always run
// against the committed example profile, so results are the same on every machine.
const exampleConfig = fileURLToPath(new URL("./src/config.example.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^(\.\.\/)+(src\/)?config\.js$/, replacement: exampleConfig }],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    env: { TELEGRAM_DRY: "1", TEST_MODE: "1" },
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
    },
  },
});
