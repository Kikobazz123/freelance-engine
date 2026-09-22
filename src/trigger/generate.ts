import { schedules, logger } from "@trigger.dev/sdk";
import { runGenerate } from "../jobs/generate.js";

/**
 * Thin Trigger.dev wrapper. The job itself lives in src/jobs/generate.ts so the
 * Inngest function can run exactly the same code. Deleted at cutover.
 */
export const generate = schedules.task({
  id: "generate",
  cron: { pattern: "15 5 * * *", timezone: "Africa/Lagos" },
  maxDuration: 300,
  run: () => runGenerate((msg, data) => logger.info(msg, (data ?? {}) as Record<string, unknown>)),
});
