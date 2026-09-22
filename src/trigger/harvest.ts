import { schedules, logger } from "@trigger.dev/sdk";
import { runHarvest } from "../jobs/harvest.js";

/**
 * Thin Trigger.dev wrapper. The job itself lives in src/jobs/harvest.ts so the
 * Inngest function can run exactly the same code. Deleted at cutover.
 */
export const harvest = schedules.task({
  id: "harvest",
  cron: { pattern: "0 6-20/2 * * *", timezone: "Africa/Lagos" },
  maxDuration: 300,
  run: () => runHarvest((msg, data) => logger.info(msg, (data ?? {}) as Record<string, unknown>)),
});
