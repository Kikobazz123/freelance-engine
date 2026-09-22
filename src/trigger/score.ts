import { schedules, logger } from "@trigger.dev/sdk";
import { sql, getState } from "../lib/db.js";
import { rescoreListings } from "../lib/rescore.js";

/**
 * Score everything unscored, plus anything re-seen recently (freshness decays,
 * so a listing's score is not stable over time).
 */
export const scoreListings = schedules.task({
  id: "score",
  cron: { pattern: "0 5 * * *", timezone: "Africa/Lagos" },
  run: async () => {
    const floor = await getState<number>("rate_floor_hourly", 35);

    // Shared with scripts/rescore.ts; see src/lib/rescore.ts for why the task
    // must not assemble its own Scorable.
    const { scored, vetoed } = await rescoreListings({ sinceDays: 2, floor });

    const [{ n: shortlist }] = (await sql`
      SELECT count(*)::int AS n FROM listings WHERE fit_score >= 65
    `) as { n: number }[];

    logger.info("scoring complete", { scored, vetoed, shortlist, rateFloor: floor });
    return { scored, vetoed, shortlist };
  },
});
