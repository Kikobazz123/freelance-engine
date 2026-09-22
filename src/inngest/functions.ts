/**
 * Every scheduled job, on Inngest.
 *
 * Replaces Trigger.dev, whose free plan capped the engine at 10 schedules and
 * about 5,000 runs a month — the 5-minute Telegram poll alone used ~6,000.
 * Inngest's free plan allows 100,000 runs a month with no schedule cap.
 *
 * Each function only supplies the clock; the job bodies live in src/jobs and are
 * exactly the code Trigger.dev ran. Crons are UTC: Nigeria keeps WAT (UTC+1) all
 * year with no daylight saving, so a fixed one-hour offset is exact and nothing
 * depends on timezone syntax.
 *
 * Each job runs inside a single step.run, so a failure is retried by Inngest
 * without re-running work an earlier attempt already completed — and the jobs
 * themselves are idempotent (ON CONFLICT inserts, conditional-update locks, a
 * unique index on sends), so a retry cannot double-send.
 *
 * Telegram polling is gone: presses arrive instantly at the webhook in
 * api/telegram.ts. Only the release sweep still needs a clock.
 */

import { inngest } from "./client.js";
import { runGithubSync } from "../jobs/github-sync.js";
import { runScoreListings } from "../jobs/score.js";
import { runGenerate } from "../jobs/generate.js";
import { runDispatch } from "../jobs/dispatch.js";
import { runSendLaneA } from "../jobs/send-lane-a.js";
import { runApplyKits } from "../jobs/apply-kits.js";
import { runHarvest } from "../jobs/harvest.js";
import { runInboxWatch } from "../jobs/inbox-watch.js";
import { runCalibrate } from "../jobs/calibrate.js";
import { releaseDueBatches } from "../lib/decisions.js";

type Job = (log: (msg: string, data?: unknown) => void) => Promise<unknown>;

/**
 * Record that a job ran. Without this there is no way to tell a quiet pipeline
 * from a stopped one — the failure that hid four nights of github-sync errors,
 * and the reason "0 replies" was indistinguishable from a broken inbox watcher.
 * Read back by scripts/status.ts and the /status command.
 */
async function heartbeat(id: string, ok: boolean, detail: string) {
  const { sql } = await import("../lib/db.js");
  await sql`
    INSERT INTO pipeline_state (key, value, updated_at)
    VALUES (${`cron:${id}`}, ${JSON.stringify({ ok, detail, at: new Date().toISOString() })}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

/** A cron-triggered function whose whole body is one durable step. */
function scheduled(id: string, cronUtc: string, description: string, job: Job) {
  return inngest.createFunction(
    { id, name: description, triggers: { cron: cronUtc }, retries: 2,
      // Never run two copies of the same job at once (a slow run overlapping the
      // next tick would otherwise stage or post twice).
      concurrency: { limit: 1 } },
    async ({ step, logger }) => {
      try {
        const out = await step.run(id, () => job((msg, data) => logger.info(msg, data ?? {})));
        await step.run(`${id}-heartbeat`, () => heartbeat(id, true, JSON.stringify(out ?? {}).slice(0, 300)));
        return out;
      } catch (e) {
        // Record the failure too, then rethrow so Inngest retries and shows it.
        await step.run(`${id}-heartbeat-fail`, () => heartbeat(id, false, String((e as Error).message).slice(0, 300)));
        throw e;
      }
    },
  );
}

/** Every job, by the id its schedule uses — so one event can run any of them. */
const JOBS: Record<string, Job> = {
  "github-sync": runGithubSync,
  "score": runScoreListings,
  "generate": runGenerate,
  "dispatch": runDispatch,
  "send-lane-a": runSendLaneA,
  "apply-kits": runApplyKits,
  "harvest": runHarvest,
  "inbox-watch": runInboxWatch,
  "calibrate": runCalibrate,
  "release-due": (log) => releaseDueBatches((s) => log(s)),
  "selftest": selfTest,
};

/**
 * Prove the deployment has what the jobs need, without sending anything.
 *
 * The CV is attached to every application and is read from disk at send time,
 * so it has to be inside the deployment bundle (vercel.json includeFiles) —
 * a fact that is otherwise only discovered when a real send fails. Same for the
 * secrets and the database.
 */
async function selfTest(log: (m: string, d?: unknown) => void) {
  const { existsSync, statSync } = await import("node:fs");
  const { sql, guard } = await import("../lib/db.js");
  const cv = "cv/Lordmark-Dorgu-AI-Automation-Engineer.pdf";
  const need = ["DATABASE_URL", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN",
    "GMAIL_SENDER", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET",
    "GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"];
  const missing = need.filter((k) => !process.env[k]);
  const [row] = (await sql`SELECT count(*)::int AS n FROM listings`) as { n: number }[];
  const g = await guard();
  const out = {
    cwd: process.cwd(),
    cvPresent: existsSync(cv),
    cvBytes: existsSync(cv) ? statSync(cv).size : 0,
    missingEnv: missing,
    listings: row.n,
    guard: g.reason,
    telegramDry: process.env.TELEGRAM_DRY === "1",
  };
  log("selftest", out);
  if (!out.cvPresent) throw new Error("CV missing from the deployment — emails would fail");
  if (missing.length) throw new Error(`missing env in deployment: ${missing.join(", ")}`);
  return out;
}

/**
 * Run any job on demand: `npm run job -- harvest`.
 *
 * Trigger.dev could invoke a deployed task directly, and that is how the
 * github-sync failure was caught — it had failed every night for four days
 * while looking fine locally. Inngest has no equivalent for a cron-only
 * function, so this event trigger restores it. It is also how a deployment is
 * verified end to end after a change.
 */
export const manualRun = inngest.createFunction(
  { id: "manual-run", name: "Run one job on demand", triggers: { event: "manual/run" }, retries: 0 },
  async ({ event, step, logger }) => {
    const name = String(event.data?.job ?? "");
    const job = JOBS[name];
    if (!job) throw new Error(`unknown job "${name}" — one of: ${Object.keys(JOBS).join(", ")}`);
    return step.run(name, () => job((msg, data) => logger.info(msg, data ?? {})));
  },
);

//                         id              UTC cron          WAT      what
export const functions = [
  manualRun,
  scheduled("github-sync", "0 3 * * *",     "04:00 WAT · refresh GitHub evidence", runGithubSync),
  scheduled("score",       "0 4 * * *",     "05:00 WAT · re-score listings", runScoreListings),
  scheduled("generate",    "15 4 * * *",    "05:15 WAT · draft marketplace proposals", runGenerate),
  scheduled("dispatch",    "30 4 * * *",    "05:30 WAT · marketplace approval cards", runDispatch),
  scheduled("send-lane-a", "45 4 * * *",    "05:45 WAT · stage the email batch", runSendLaneA),
  scheduled("apply-kits",  "15 5 * * *",    "06:15 WAT · post apply kits", runApplyKits),
  scheduled("harvest",     "0 5-19/2 * * *", "06:00-20:00 WAT every 2h · harvest + discover", runHarvest),
  scheduled("inbox-watch", "0 7-19/2 * * *", "08:00-20:00 WAT every 2h · watch for replies", runInboxWatch),
  scheduled("calibrate",   "0 17 * * 0",    "Sunday 18:00 WAT · weekly calibration", runCalibrate),
  // Was folded into poll-callbacks on Trigger.dev to dodge the schedule cap.
  scheduled("release-due", "*/5 4-21 * * *", "05:00-22:55 WAT every 5 min · release overdue batches",
    (log) => releaseDueBatches((s) => log(s))),
];
