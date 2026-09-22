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

/** A cron-triggered function whose whole body is one durable step. */
function scheduled(id: string, cronUtc: string, description: string, job: Job) {
  return inngest.createFunction(
    { id, name: description, triggers: { cron: cronUtc }, retries: 2,
      // Never run two copies of the same job at once (a slow run overlapping the
      // next tick would otherwise stage or post twice).
      concurrency: { limit: 1 } },
    async ({ step, logger }) =>
      step.run(id, () => job((msg, data) => logger.info(msg, data ?? {}))),
  );
}

//                         id              UTC cron          WAT      what
export const functions = [
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
