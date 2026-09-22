/**
 * Confirm the deployed schedules actually registered.
 *
 * `schedules.list()` is scoped to the environment the TRIGGER_SECRET_KEY belongs
 * to. A tr_dev_ key lists DEV schedules, while `trigger.dev deploy` targets PROD
 * — so a dev key reporting zero proves nothing about the deployment. Run this
 * with a tr_prod_ key to actually verify.
 *
 *   tsx scripts/check-deploy.ts
 */
import "dotenv/config";
import { schedules, configure } from "@trigger.dev/sdk";

// Prefer an explicitly-provided prod key. Keeping it under its own name means
// TRIGGER_SECRET_KEY can stay dev-scoped for local work without the two fighting.
const key = process.env.TRIGGER_PROD_SECRET_KEY || process.env.TRIGGER_SECRET_KEY || "";
if (process.env.TRIGGER_PROD_SECRET_KEY) {
  configure({ secretKey: process.env.TRIGGER_PROD_SECRET_KEY });
}
const env = key.startsWith("tr_prod_") ? "prod"
          : key.startsWith("tr_dev_") ? "dev"
          : "unknown";

console.log(`key scope: ${env}`);
if (env !== "prod") {
  console.log(`\nThis key is scoped to '${env}'. Deployments go to prod, so any count`);
  console.log(`below says nothing about the deployment. Get a tr_prod_ key from`);
  console.log(`cloud.trigger.dev -> freelance-engine -> API keys (PROD), then re-run.\n`);
}

const list = await schedules.list();
console.log(`schedules visible in '${env}': ${list.data?.length ?? 0}`);
for (const s of list.data ?? []) {
  console.log(`  ${(s.task ?? "?").padEnd(16)} ${String(s.generator?.expression ?? "?").padEnd(16)} ${s.active ? "ACTIVE" : "paused"}`);
}

const EXPECTED = ["harvest","score","generate","dispatch","send-lane-a",
                  "inbox-watch","poll-callbacks","calibrate","github-sync",
                  // poll-callbacks also releases overdue batches (it absorbed
                  // auto-release when the free plan's 10-schedule cap was hit).
                  "apply-kits"];
const seen = new Set((list.data ?? []).map((s) => s.task));
const missing = EXPECTED.filter((t) => !seen.has(t));
if (env === "prod") {
  console.log(missing.length ? `\nMISSING: ${missing.join(", ")}` : `\nall ${EXPECTED.length} schedules registered`);
}
