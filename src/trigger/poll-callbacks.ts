import { schedules, logger } from "@trigger.dev/sdk";
import { runPollCallbacks } from "../jobs/poll-callbacks.js";

/**
 * Thin Trigger.dev wrapper. The job itself lives in src/jobs/poll-callbacks.ts so the
 * Inngest function can run exactly the same code. Deleted at cutover.
 */
export const pollCallbacks = schedules.task({
  id: "poll-callbacks",
  cron: { pattern: "*/5 5-22 * * *", timezone: "Africa/Lagos" },
  maxDuration: 600,
  run: () => runPollCallbacks((msg, data) => logger.info(msg, (data ?? {}) as Record<string, unknown>)),
});
