import { schedules, logger } from "@trigger.dev/sdk";
import { upsertListings } from "../lib/db.js";
import { harvestAll } from "../lib/sources.js";

/**
 * Pull every RSS/JSON source and upsert into `listings`.
 *
 * Every 30 minutes rather than once daily, and that is the point: on the bidding
 * marketplaces the first handful of proposals capture a disproportionate share of
 * client views. Being early beats being polished, and almost nobody automates it
 * within terms.
 */
export const harvest = schedules.task({
  id: "harvest",
  cron: { pattern: "0 6-20/2 * * *", timezone: "Africa/Lagos" },
  maxDuration: 300,
  run: async () => {
    const { rows, report } = await harvestAll();

    const live = report.filter((r) => r.status === "ok").length;
    logger.info("harvest complete", {
      sourcesTried: report.length,
      sourcesLive: live,
      rows: rows.length,
    });

    // A few dead feeds are normal; a majority dead means something systemic
    // (network, UA blocking) and is worth surfacing rather than silently halving
    // the funnel.
    if (live < report.length / 2) {
      logger.warn("over half of sources failed", {
        failed: report.filter((r) => r.status !== "ok").map((r) => `${r.source}:${r.err}`),
      });
    }

    // Batched: row-at-a-time was ~1000 HTTP round trips and would blow maxDuration.
    // scoreToo:false so harvest never clobbers scores that score.ts owns.
    const { inserted, total } = await upsertListings(rows, { scoreToo: false });

    logger.info("listings upserted", { seen: rows.length, new: inserted, total });
    return { seen: rows.length, new: inserted, total, sourcesLive: live };
  },
});
