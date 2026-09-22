import { schedules, logger } from "@trigger.dev/sdk";
import { runGithubSync } from "../jobs/github-sync.js";

/**
 * Thin Trigger.dev wrapper. The job itself lives in src/jobs/github-sync.ts so the
 * Inngest function can run exactly the same code. Deleted at cutover.
 */
export const githubSync = schedules.task({
  id: "github-sync",
  cron: { pattern: "0 4 * * *", timezone: "Africa/Lagos" },
  maxDuration: 180,
  run: () => runGithubSync((msg, data) => logger.info(msg, (data ?? {}) as Record<string, unknown>)),
});
