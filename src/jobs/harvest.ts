import { upsertListings } from "../lib/db.js";
import { harvestAll } from "../lib/sources.js";
import { rescoreListings } from "../lib/rescore.js";
import { discoverListings } from "../lib/discover-run.js";

/** Postings probed per harvest. 8 runs a day covers far more than arrive. */
const DISCOVER_PER_RUN = 15;

/**
 * Pull every RSS/JSON source and upsert into `listings`.
 *
 * Every 30 minutes rather than once daily, and that is the point: on the bidding
 * marketplaces the first handful of proposals capture a disproportionate share of
 * client views. Being early beats being polished, and almost nobody automates it
 * within terms.
 */

export type Log = (msg: string, data?: unknown) => void;

/**
 * Job body, runner-agnostic. Called by the Inngest function (src/inngest) and,
 * until the cutover is complete, by the Trigger.dev wrapper in src/trigger.
 */
export async function runHarvest(log: Log = () => {}) {
    const { rows, report } = await harvestAll();

    const live = report.filter((r) => r.status === "ok").length;
    log("harvest complete", {
      sourcesTried: report.length,
      sourcesLive: live,
      rows: rows.length,
    });

    // A few dead feeds are normal; a majority dead means something systemic
    // (network, UA blocking) and is worth surfacing rather than silently halving
    // the funnel.
    if (live < report.length / 2) {
      log("over half of sources failed", {
        failed: report.filter((r) => r.status !== "ok").map((r) => `${r.source}:${r.err}`),
      });
    }

    // Batched: row-at-a-time was ~1000 HTTP round trips and would blow maxDuration.
    // scoreToo:false so harvest never clobbers scores that score.ts owns.
    const { inserted, total } = await upsertListings(rows, { scoreToo: false });

    log("listings upserted", { seen: rows.length, new: inserted, total });

    /*
     * Score the new rows now, then look for their apply addresses.
     *
     * New listings used to wait for the 05:00 score run, so a posting harvested
     * at 09:00 could not be discovered, staged or sent until the next morning —
     * losing most of a day on exactly the listings where being early matters.
     * Only unscored rows are touched (sinceDays 0), so the daily re-score still
     * owns everything else. Discovery is capped per run to stay well inside
     * maxDuration; anything it misses is picked up two hours later.
     */
    const s = await rescoreListings({ sinceDays: 0, includeUnscored: true });
    const d = await discoverListings(DISCOVER_PER_RUN, { log: (x) => log(x) });
    log("scored and discovered", { scored: s.scored, probed: d.probed, found: d.found });

    return {
      seen: rows.length, new: inserted, total, sourcesLive: live,
      scored: s.scored, discovered: d.found, probed: d.probed,
    };
}
