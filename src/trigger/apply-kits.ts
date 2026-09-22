import { schedules, logger } from "@trigger.dev/sdk";
import { runApplyKits } from "../jobs/apply-kits.js";

/**
 * Thin Trigger.dev wrapper. The job itself lives in src/jobs/apply-kits.ts so the
 * Inngest function can run exactly the same code. Deleted at cutover.
 */
export const applyKits = schedules.task({
  id: "apply-kits",
  cron: { pattern: "15 6 * * *", timezone: "Africa/Lagos" },
  maxDuration: 300,
  run: () => runApplyKits((msg, data) => logger.info(msg, (data ?? {}) as Record<string, unknown>)),
});
