/**
 * Re-score listings with the current rules. Shared by the daily task and the
 * one-off backfill, so there is exactly one definition of how a stored row is
 * turned into a score.
 *
 * The daily task used to build its own Scorable and left out market_tier and
 * market_confidence. score() treats a missing tier as unknown, so in production
 * no listing ever received the strong-currency bonus (+18 for a confirmed US or
 * EU client) — local runs did, and the two disagreed about the same listing.
 */

import { sql } from "./db.js";
import { score } from "./scoring.js";
import { flagsFor, withEligibility } from "./sources.js";
import { eligibility } from "./eligibility.js";

export async function rescoreListings(opts: {
  sinceDays: number; includeUnscored?: boolean; floor?: number;
}): Promise<{ scored: number; vetoed: number; changed: number }> {
  const { sinceDays, includeUnscored = true, floor = 35 } = opts;

  const rows = (await sql`
    SELECT id, title, tier, stack_tags, red_flags, rate_min, rate_type, posted_at,
           market_tier, market_confidence, fit_score, source, description, location,
           rank_score
    FROM listings
    WHERE (${includeUnscored} AND fit_score IS NULL)
       OR last_seen_at > now() - (${sinceDays} || ' days')::interval
  `) as any[];

  let scored = 0, vetoed = 0, changed = 0;
  const updates: { id: string; sc: number; why: string; flags: string[]; raw: number }[] = [];
  for (const r of rows) {
    /*
     * Re-derive flags with today's rules, as a UNION with what is stored.
     *
     * Only a harvest used to compute flags, so a listing that had dropped out
     * of the feeds kept whatever the rules were the day it was seen — "Remote
     * (US)" stayed unflagged after the US-only pattern learned that wording.
     * The stored flags were computed from the full posting body, which older
     * rows no longer have, so nothing stored is ever removed: a union can add a
     * flag the new rules find, never lose one the old body proved.
     */
    const stored: string[] = r.red_flags ?? [];
    const derived = withEligibility(
      flagsFor(`${r.title} ${r.description ?? ""}`, r.source ?? "", r.title), r.location ?? "",
    ).split("|").filter(Boolean);
    const flags = [...new Set([...stored, ...derived])];
    const flagsMoved = flags.length !== stored.length;

    const { score: sc, why, raw } = score({
      title: r.title,
      tier: r.tier,
      stack_tags: (r.stack_tags ?? []).join("|"),
      red_flags: flags.join("|"),
      rate_min: r.rate_min,
      rate_type: r.rate_type,
      posted_at: r.posted_at ? new Date(r.posted_at).toISOString() : null,
      market_tier: r.market_tier ?? null,
      market_confidence: r.market_confidence ?? null,
      eligibility: eligibility(r.location),
      source: r.source ?? null,
    }, floor);

    scored++;
    if (sc === 0) vetoed++;
    // Only write what moved. Most rows re-score to the same number.
    if (sc !== r.fit_score || flagsMoved || raw !== r.rank_score) {
      if (sc !== r.fit_score) changed++;
      updates.push({ id: r.id, sc, why, flags, raw });
    }
  }

  /*
   * Batched, for the same reason upsertListings is: Neon's driver is HTTP, and
   * one UPDATE per row over ~2,000 rows took minutes and died part-way through
   * on a single dropped connection. One statement per 200 rows.
   */
  for (let i = 0; i < updates.length; i += 200) {
    const slice = updates.slice(i, i + 200);
    const params: unknown[] = [];
    const tuples = slice.map((u) => {
      params.push(u.id, u.sc, u.why, u.flags, u.raw);
      const b = params.length - 5;
      return `($${b + 1}::text, $${b + 2}::int, $${b + 3}::text, $${b + 4}::text[], $${b + 5}::int)`;
    });
    await sql(
      `UPDATE listings AS l SET fit_score = v.s, score_why = v.w, red_flags = v.f, rank_score = v.r
       FROM (VALUES ${tuples.join(",")}) AS v(id, s, w, f, r)
       WHERE l.id = v.id`,
      params,
    );
  }
  return { scored, vetoed, changed };
}
