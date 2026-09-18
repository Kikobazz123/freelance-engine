import { schedules, logger } from "@trigger.dev/sdk";
import { sql, getState } from "../lib/db.js";
import { score } from "../lib/scoring.js";

/**
 * Score everything unscored, plus anything re-seen recently (freshness decays,
 * so a listing's score is not stable over time).
 */
export const scoreListings = schedules.task({
  id: "score",
  cron: { pattern: "0 5 * * *", timezone: "Africa/Lagos" },
  run: async () => {
    const floor = await getState<number>("rate_floor_hourly", 35);

    const rows = (await sql`
      SELECT id, title, tier, stack_tags, red_flags, rate_min, rate_type, posted_at
      FROM listings
      WHERE fit_score IS NULL
         OR last_seen_at > now() - interval '2 days'
    `) as any[];

    let scored = 0, vetoed = 0;
    for (const r of rows) {
      const { score: sc, why } = score({
        title: r.title,
        tier: r.tier,
        stack_tags: (r.stack_tags ?? []).join("|"),
        red_flags: (r.red_flags ?? []).join("|"),
        rate_min: r.rate_min,
        rate_type: r.rate_type,
        posted_at: r.posted_at ? new Date(r.posted_at).toISOString() : null,
      }, floor);

      await sql`UPDATE listings SET fit_score = ${sc}, score_why = ${why} WHERE id = ${r.id}`;
      scored++;
      if (sc === 0) vetoed++;
    }

    const [{ n: shortlist }] = (await sql`
      SELECT count(*)::int AS n FROM listings WHERE fit_score >= 65
    `) as { n: number }[];

    logger.info("scoring complete", { scored, vetoed, shortlist, rateFloor: floor });
    return { scored, vetoed, shortlist };
  },
});
