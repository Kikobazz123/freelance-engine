import { schedules, logger } from "@trigger.dev/sdk";
import { runScoreListings } from "../jobs/score.js";

/**
 * Thin Trigger.dev wrapper. The job itself lives in src/jobs/score.ts so the
 * Inngest function can run exactly the same code. Deleted at cutover.
 */
export const scoreListings = schedules.task({
  id: "score",
  cron: { pattern: "0 5 * * *", timezone: "Africa/Lagos" },
  run: () => runScoreListings((msg, data) => logger.info(msg, (data ?? {}) as Record<string, unknown>)),
});
