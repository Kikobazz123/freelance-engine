/**
 * Move the scheduled jobs from Trigger.dev to Inngest + Vercel, in checked steps.
 *
 *   node scripts/cutover.mjs check      credentials present? (names only)
 *   node scripts/cutover.mjs env        copy .env secrets to Vercel (production)
 *   node scripts/cutover.mjs deploy     deploy to Vercel, remember the URL
 *   node scripts/cutover.mjs verify     endpoint up, 10 functions, signing key seen
 *   node scripts/cutover.mjs sync       register the app with Inngest Cloud
 *   node scripts/cutover.mjs webhook    point Telegram at the webhook
 *   node scripts/cutover.mjs retire     pause every Trigger.dev schedule
 *   node scripts/cutover.mjs all        every step above, stopping at the first failure
 *   node scripts/cutover.mjs rollback   remove the webhook, re-activate Trigger.dev
 *
 * Order matters at the end. Inngest is synced BEFORE Trigger.dev is paused, so
 * there is no window with no scheduler at all; the overlap is harmless because
 * every job is idempotent (locks, ON CONFLICT, a unique index on sends).
 *
 * Never prints a secret: values are piped to the Vercel CLI on stdin.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const STATE = ".vercel/cutover.json";
const step = process.argv[2] ?? "check";
const T = process.env.VERCEL_TOKEN;

const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s) => { mkdirSync(".vercel", { recursive: true }); writeFileSync(STATE, JSON.stringify({ ...state(), ...s }, null, 2)); };
const fail = (m) => { console.error(`\nFAILED: ${m}`); process.exit(1); };
const ok = (m) => console.log(`  ok  ${m}`);

function vercel(args, input) {
  const r = spawnSync("npx", ["--yes", "vercel@latest", ...args, "--token", T], {
    input, encoding: "utf8", shell: true, maxBuffer: 20 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}`, err: `${r.stderr ?? ""}` };
}

/** Everything in .env the deployed functions need. */
function envForVercel() {
  const SKIP = /^(TRIGGER_|VERCEL_TOKEN$|PORT$)/;
  const vars = {};
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || SKIP.test(m[1])) continue;
    let v = m[2];
    if (v.length >= 2 && v[0] === v.at(-1) && `"'`.includes(v[0])) v = v.slice(1, -1);
    if (v) vars[m[1]] = v;
  }
  return vars;
}

const steps = {
  async check() {
    const need = ["VERCEL_TOKEN", "INNGEST_SIGNING_KEY", "INNGEST_EVENT_KEY", "TELEGRAM_WEBHOOK_SECRET",
                  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "DATABASE_URL"];
    const missing = need.filter((k) => !process.env[k]);
    for (const k of need) console.log(`  ${process.env[k] ? "set    " : "MISSING"}  ${k}`);
    if (missing.length) fail(`fill these in .env first: ${missing.join(", ")}`);
    if (!existsSync("cv/Lordmark-Dorgu-AI-Automation-Engineer.pdf")) fail("the CV PDF is missing from cv/");
    ok("all credentials present");
  },

  async env() {
    if (!T) fail("VERCEL_TOKEN is empty");
    const link = vercel(["link", "--yes", "--project", "freelance-engine"]);
    if (link.code !== 0) fail(`vercel link: ${link.err.slice(-300)}`);
    ok("linked Vercel project freelance-engine");
    const vars = envForVercel();
    for (const [k, v] of Object.entries(vars)) {
      vercel(["env", "rm", k, "production", "--yes"]);            // idempotent re-runs
      const r = vercel(["env", "add", k, "production"], v);
      if (r.code !== 0) fail(`env add ${k}: ${r.err.slice(-200)}`);
    }
    ok(`copied ${Object.keys(vars).length} variables to Vercel production (values not shown)`);
  },

  async deploy() {
    const r = vercel(["deploy", "--prod", "--yes"]);
    if (r.code !== 0) fail(`deploy: ${(r.err || r.out).slice(-800)}`);
    const urls = `${r.out}\n${r.err}`.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/g) ?? [];
    // Prefer the stable production alias over the per-deployment URL.
    const url = urls.find((u) => /^https:\/\/freelance-engine[a-z0-9-]*\.vercel\.app$/.test(u) && !/-[a-z0-9]{9}-/.test(u)) ?? urls.at(-1);
    if (!url) fail("deployed, but could not find the URL in the output");
    save({ url });
    ok(`deployed: ${url}`);
  },

  async verify() {
    const { url } = state();
    if (!url) fail("no URL yet — run deploy");
    const r = await fetch(`${url}/api/inngest`);
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200) fail(`GET /api/inngest -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    if (j.function_count !== 10) fail(`expected 10 functions, saw ${j.function_count}`);
    if (!j.has_signing_key) fail("the deployment cannot see INNGEST_SIGNING_KEY");
    ok(`endpoint up: ${j.function_count} functions, mode ${j.mode}, signing key present`);
    const w = await fetch(`${url}/api/telegram`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    if (w.status !== 401) fail(`webhook accepted a request without the secret (${w.status})`);
    ok("webhook rejects requests without the secret");
  },

  async sync() {
    const { url } = state();
    const r = await fetch(`${url}/api/inngest`, { method: "PUT" });
    const t = await r.text();
    if (!r.ok) fail(`Inngest sync -> ${r.status} ${t.slice(0, 300)}`);
    ok(`registered with Inngest Cloud (${r.status})`);
  },

  async webhook() {
    const { url } = state();
    const api = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
    const r = await fetch(`${api}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `${url}/api/telegram`,
        secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["callback_query", "message"],
        drop_pending_updates: false,
      }),
    }).then((x) => x.json());
    if (!r.ok) fail(`setWebhook: ${r.description}`);
    const info = await fetch(`${api}/getWebhookInfo`).then((x) => x.json());
    if (info.result?.url !== `${url}/api/telegram`) fail("Telegram does not report the new webhook URL");
    ok(`Telegram now delivers presses to ${url}/api/telegram (pending: ${info.result.pending_update_count})`);
  },

  async retire() {
    const { configure, schedules } = await import("@trigger.dev/sdk");
    configure({ secretKey: process.env.TRIGGER_PROD_SECRET_KEY });
    const list = await schedules.list();
    let n = 0;
    for (const s of list.data ?? []) {
      if (s.active) { await schedules.deactivate(s.id); n++; }
    }
    save({ triggerRetiredAt: new Date().toISOString() });
    ok(`paused ${n} Trigger.dev schedule(s) — kept, not deleted, so rollback is instant`);
  },

  async rollback() {
    const api = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
    const d = await fetch(`${api}/deleteWebhook`, { method: "POST" }).then((x) => x.json());
    ok(`Telegram webhook removed (${d.ok}); polling works again`);
    const { configure, schedules } = await import("@trigger.dev/sdk");
    configure({ secretKey: process.env.TRIGGER_PROD_SECRET_KEY });
    const list = await schedules.list();
    for (const s of list.data ?? []) if (!s.active) await schedules.activate(s.id);
    ok(`re-activated ${(list.data ?? []).length} Trigger.dev schedule(s)`);
    console.log("  note: Inngest will keep firing until the app is paused or archived in its dashboard.");
  },

  async all() {
    for (const s of ["check", "env", "deploy", "verify", "sync", "webhook", "retire"]) {
      console.log(`\n== ${s} ==`);
      await steps[s]();
    }
    console.log("\ncutover complete.");
  },
};

if (!steps[step]) fail(`unknown step "${step}"`);
console.log(`== ${step} ==`);
await steps[step]();
