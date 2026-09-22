import { schedules, logger } from "@trigger.dev/sdk";
import { releaseDueBatches } from "../lib/decisions.js";

/**
 * Send batches that were never reviewed.
 *
 * The digest made review possible; it also made it mandatory, and that stopped
 * the pipeline dead. Three consecutive mornings staged drafts, posted a card,
 * and sent nothing because nobody pressed the button. A review step you can
 * forget about is an outage with extra steps.
 *
 * So the deadline is the default and the tap is the shortcut: press Approve to
 * send now, press Hold to stop the clock, or do nothing and it goes out on its
 * own.
 *
 * All the real work — deciding what is due, the lock, the gates, the card
 * repaint — lives in releaseDueBatches() and executeBatch(), shared with the
 * button and the CLI. This task only supplies the clock.
 */

export const autoRelease = schedules.task({
  id: "auto-release",
  cron: { pattern: "*/15 5-22 * * *", timezone: "Africa/Lagos" },
  maxDuration: 600,
  run: async () => {
    const r = await releaseDueBatches((s) => logger.info(s));
    if (r.released) logger.info("auto-release complete", r);
    return r;
  },
});
