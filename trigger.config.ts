import { defineConfig } from "@trigger.dev/sdk";

// Project ref for `freelance-engine` at cloud.trigger.dev.
//
// A literal, not an env lookup. Not a secret — it is a public project identifier —
// and more importantly trigger.config.ts is evaluated BEFORE .env is loaded, so
// reading it from process.env resolves to undefined and silently falls back. That
// is exactly what happened here: the config reported "proj_REPLACE_ME" until this
// was inlined. Same pattern, and same reason, as lordgen-daily-report.
//
// The env var is still honoured first so CI can override it, but the literal is
// what actually runs locally.
//
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_REPLACE_WITH_YOURS",
  dirs: ["./src/trigger"],
  // Harvest fans out across ~35 feeds; 5 min is comfortable headroom.
  maxDuration: 300,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
});
