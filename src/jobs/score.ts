import { sql, getState } from "../lib/db.js";
import { rescoreListings } from "../lib/rescore.js";

/**
 * Score everything unscored, plus anything re-seen recently (freshness decays,
 * so a listing's score is not stable over time).
 */

export type Log = (msg: string, data?: unknown) => void;

/**
 * Job body, runner-agnostic. Called by the Inngest function (src/inngest) and,
 * until the cutover is complete, by the Trigger.dev wrapper in src/trigger.
 */
export async function runScoreListings(log: Log = () => {}) {
    const floor = await getState<number>("rate_floor_hourly", 35);

    // Shared with scripts/rescore.ts; see src/lib/rescore.ts for why the task
    // must not assemble its own Scorable.
    const { scored, vetoed } = await rescoreListings({ sinceDays: 2, floor });

    const [{ n: shortlist }] = (await sql`
      SELECT count(*)::int AS n FROM listings WHERE fit_score >= 65
    `) as { n: number }[];

    log("scoring complete", { scored, vetoed, shortlist, rateFloor: floor });
    return { scored, vetoed, shortlist };
}
