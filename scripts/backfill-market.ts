/**
 * Backfill market detection over rows stored before the market columns existed.
 * Idempotent; safe to re-run after any change to geo.ts.
 *
 *   tsx scripts/backfill-market.ts
 */

import "dotenv/config";
import { sql } from "../src/lib/db.js";
import { marketOf } from "../src/lib/geo.js";
import { score } from "../src/lib/scoring.js";

type Row = {
  id: string; title: string; source: string; url: string; tier: string;
  stack_tags: string[] | null; red_flags: string[] | null;
  rate_min: number | null; rate_type: string | null; posted_at: string | null;
};

const rows = (await sql`
  SELECT id, title, source, url, tier, stack_tags, red_flags,
         rate_min, rate_type, posted_at
  FROM listings
`) as Row[];

console.log(`backfilling ${rows.length} rows...`);

const CHUNK = 200;
let done = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const slice = rows.slice(i, i + CHUNK);
  const params: unknown[] = [];
  const tuples = slice.map((r) => {
    const mk = marketOf(r.title, r.source, r.url);
    const { score: sc, why } = score({
      title: r.title, tier: r.tier,
      stack_tags: (r.stack_tags ?? []).join("|"),
      red_flags: (r.red_flags ?? []).join("|"),
      rate_min: r.rate_min, rate_type: r.rate_type,
      posted_at: r.posted_at ? new Date(r.posted_at).toISOString() : null,
      market_tier: mk.tier, market_confidence: mk.confidence,
    });
    const b = params.length;
    params.push(r.id, mk.market, mk.tier, mk.confidence, mk.signal, sc, why);
    return `($${b + 1},$${b + 2},$${b + 3}::smallint,$${b + 4},$${b + 5},$${b + 6}::int,$${b + 7})`;
  });

  await sql(
    `UPDATE listings AS l SET
       market = v.market, market_tier = v.tier,
       market_confidence = v.conf, market_signal = v.sig,
       fit_score = v.score, score_why = v.why
     FROM (VALUES ${tuples.join(",")})
       AS v(id, market, tier, conf, sig, score, why)
     WHERE l.id = v.id`,
    params,
  );
  done += slice.length;
}

const [stats] = (await sql`
  SELECT count(*) FILTER (WHERE market_tier = 1)::int AS t1,
         count(*) FILTER (WHERE market_tier = 2)::int AS t2,
         count(*) FILTER (WHERE market_tier = 3)::int AS t3,
         count(*) FILTER (WHERE market_tier = 0)::int AS unknown,
         count(*) FILTER (WHERE lane='approve' AND fit_score >= 85
                            AND market_tier <> 3)::int AS bid_eligible,
         count(*) FILTER (WHERE lane='auto' AND fit_score >= 65
                            AND market_tier <> 3)::int AS outreach_eligible
  FROM listings
`) as any[];

console.log(`done: ${done} rows`);
console.log(`  tier1 ${stats.t1}  tier2 ${stats.t2}  tier3(veto) ${stats.t3}  unknown ${stats.unknown}`);
console.log(`  bid eligible (approve, >=85, not tier3): ${stats.bid_eligible}`);
console.log(`  outreach eligible (auto, >=65, not tier3): ${stats.outreach_eligible}`);
