import { schedules, logger } from "@trigger.dev/sdk";
import { runDispatch } from "../jobs/dispatch.js";

/**
 * Thin Trigger.dev wrapper. The job itself lives in src/jobs/dispatch.ts so the
 * Inngest function can run exactly the same code. Deleted at cutover.
 */
export const dispatch = schedules.task({
  id: "dispatch",
  cron: { pattern: "30 5 * * *", timezone: "Africa/Lagos" },
  maxDuration: 300,
  run: () => runDispatch((msg, data) => logger.info(msg, (data ?? {}) as Record<string, unknown>)),
});
