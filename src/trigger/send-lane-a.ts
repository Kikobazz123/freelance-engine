import { schedules, logger } from "@trigger.dev/sdk";
import { runSendLaneA } from "../jobs/send-lane-a.js";

/**
 * Thin Trigger.dev wrapper. The job itself lives in src/jobs/send-lane-a.ts so the
 * Inngest function can run exactly the same code. Deleted at cutover.
 */
export const sendLaneA = schedules.task({
  id: "send-lane-a",
  cron: { pattern: "45 5 * * *", timezone: "Africa/Lagos" },
  maxDuration: 300,
  run: () => runSendLaneA((msg, data) => logger.info(msg, (data ?? {}) as Record<string, unknown>)),
});
