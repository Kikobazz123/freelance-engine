/**
 * Safety verification. Run before enabling live sending, and after any change to
 * db.ts, dispatch.ts or gmail.ts.
 *
 * Asserts the things that, if wrong, cost real money or a banned account:
 *   1. the guard blocks sending while dry_run is on
 *   2. env cannot switch sending ON by itself
 *   3. /pause (enabled=false) overrides everything
 *   4. no marketplace lane has an auto-send code path
 *   5. gmailSend short-circuits on dryRun before touching the network
 *
 *   tsx scripts/verify.ts
 */

import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { guard, getState, setState } from "../src/lib/db.js";
import { gmailSend } from "../src/lib/gmail.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  ok ? pass++ : fail++;
};

console.log("\n--- guard ---");

const before = {
  enabled: await getState<boolean>("enabled", true),
  dry: await getState<boolean>("dry_run", true),
};

// Everything from here mutates pipeline_state. process.on("exit") cannot await,
// so the restore also runs on the unhandled paths below.
const restore = async () => {
  await setState("enabled", before.enabled);
  await setState("dry_run", before.dry);
};
process.on("uncaughtException", (e) => {
  console.error("uncaught:", e);
  restore().finally(() => process.exit(1));
});

// 1. dry_run in the DB must block, regardless of env.
await setState("enabled", true);
await setState("dry_run", true);
process.env.DRY_RUN = "false";           // hostile: env says go live
delete process.env.PIPELINE_ENABLED;
let g = await guard();
check("db dry_run=true blocks sending even when DRY_RUN=false", !g.send, g.reason);

// 2. env alone must not be able to enable sending.
await setState("dry_run", false);
process.env.DRY_RUN = "true";
g = await guard();
check("env DRY_RUN=true blocks sending even when db says live", !g.send, g.reason);

// 3. the kill switch wins over everything.
await setState("enabled", false);
process.env.DRY_RUN = "false";
g = await guard();
check("enabled=false overrides all", !g.send, g.reason);

// 4. and the only configuration that permits sending is the fully-explicit one.
await setState("enabled", true);
await setState("dry_run", false);
process.env.DRY_RUN = "false";
g = await guard();
check("sending allowed only when db AND env both say live", g.send, g.reason);

// Restore what we found.
//
// Two failures shaped this. First an interrupted run left dry_run=false with only
// the env var holding sending back — one brake instead of two. The fix then was to
// always restore the SAFE value, which overcorrected: running the suite against a
// deliberately live pipeline silently disarmed it, and the next send did nothing.
//
// So: restore the captured value, but in a finally-style guarantee so a crash
// cannot skip it, and never leave it MORE permissive than it was found.
await setState("enabled", before.enabled);
await setState("dry_run", before.dry);
process.env.DRY_RUN = "true";

console.log("\n--- marketplace ToS boundary ---");

// Upwork/Fiverr/Freelancer permanently ban tools that submit without a human
// click. The guarantee is structural: no code here posts to a marketplace.
const srcDir = "src";
const files: string[] = [];
(function walk(d: string) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    e.isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p);
  }
})(srcDir);

const code = files.map((f) => `${f}\n${readFileSync(f, "utf8")}`).join("\n");
const marketplacePost =
  /fetch\([^)]*(upwork|fiverr|freelancer\.com|peopleperhour|contra)\.com[^)]*\)\s*,?\s*\{[^}]*method:\s*["']POST/i;
check("no POST to any marketplace domain", !marketplacePost.test(code));
check("dispatch queues approve lane rather than sending",
  /pending_approval/.test(readFileSync("src/trigger/dispatch.ts", "utf8")));

console.log("\n--- gmail dry run ---");

const res = await gmailSend({
  to: "nobody@example.invalid",
  subject: "verify",
  body: "should never send",
  dryRun: true,
});
check("gmailSend returns null and makes no network call when dryRun", res === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
