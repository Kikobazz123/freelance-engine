import { schedules, logger } from "@trigger.dev/sdk";
import { runCalibrate } from "../jobs/calibrate.js";

/**
 * Thin Trigger.dev wrapper. The job itself lives in src/jobs/calibrate.ts so the
 * Inngest function can run exactly the same code. Deleted at cutover.
 */
export const calibrate = schedules.task({
  id: "calibrate",
  cron: { pattern: "0 18 * * 0", timezone: "Africa/Lagos" },
  run: () => runCalibrate((msg, data) => logger.info(msg, (data ?? {}) as Record<string, unknown>)),
});
