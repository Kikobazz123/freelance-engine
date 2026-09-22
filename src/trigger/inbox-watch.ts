import { schedules, logger } from "@trigger.dev/sdk";
import { runInboxWatch } from "../jobs/inbox-watch.js";

/**
 * Thin Trigger.dev wrapper. The job itself lives in src/jobs/inbox-watch.ts so the
 * Inngest function can run exactly the same code. Deleted at cutover.
 */
export const inboxWatch = schedules.task({
  id: "inbox-watch",
  cron: { pattern: "0 8-20/2 * * *", timezone: "Africa/Lagos" },
  run: () => runInboxWatch((msg, data) => logger.info(msg, (data ?? {}) as Record<string, unknown>)),
});
