/**
 * Measure geo detection against the listings already in Neon, before it gates
 * anything. Prints the distribution, the signal that fired for each, and a random
 * sample of Tier 3 vetoes for hand-checking — a false veto costs a bid from a
 * budget of six per month, so the error rate has to be known, not assumed.
 *
 *   tsx scripts/geo-audit.ts
 */

import "dotenv/config";
import { sql } from "../src/lib/db.js";
import { marketOf } from "../src/lib/geo.js";

type Row = { id: string; title: string; source: string; url: string; fit_score: number };

const rows = (await sql`
  SELECT id, title, source, url, coalesce(fit_score, 0) AS fit_score
  FROM listings
`) as Row[];

const hits = rows.map((r) => ({ r, hit: marketOf(r.title, r.source, r.url) }));

const byTier = new Map<number, number>();
const byMarket = new Map<string, number>();
const bySignal = new Map<string, number>();
for (const { hit } of hits) {
  byTier.set(hit.tier, (byTier.get(hit.tier) ?? 0) + 1);
  byMarket.set(hit.market, (byMarket.get(hit.market) ?? 0) + 1);
  const kind = hit.signal.split(":")[0];
  bySignal.set(kind, (bySignal.get(kind) ?? 0) + 1);
}

const n = rows.length;
const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;

console.log(`\nlistings analysed: ${n}\n`);
console.log("TIER DISTRIBUTION");
for (const t of [1, 2, 3, 0]) {
  const c = byTier.get(t) ?? 0;
  const label = t === 0 ? "unknown (never vetoed)" : `tier ${t}`;
  console.log(`  ${label.padEnd(24)} ${String(c).padStart(5)}  ${pct(c)}`);
}

console.log("\nSIGNAL THAT FIRED");
for (const [k, v] of [...bySignal].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${String(v).padStart(5)}  ${pct(v)}`);
}

console.log("\nTOP MARKETS");
for (const [k, v] of [...byMarket].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`  ${k.padEnd(24)} ${String(v).padStart(5)}  ${pct(v)}`);
}

// The expensive error: a good listing wrongly vetoed. Sample for hand-checking.
const vetoed = hits.filter((h) => h.hit.tier === 3);
console.log(`\nTIER 3 VETOES — ${vetoed.length} total, random 20 for hand-check:`);
for (const { r, hit } of vetoed.sort(() => Math.random() - 0.5).slice(0, 20)) {
  console.log(`  [${hit.market} via ${hit.signal}]`);
  console.log(`     ${r.title.slice(0, 96)}`);
}

// The other risk: high-scoring listings we would now spend a bid on.
const bidCandidates = hits.filter(
  (h) => h.r.fit_score >= 85 && (h.hit.tier === 1 || h.hit.tier === 2),
);
console.log(`\nWOULD QUALIFY FOR A MARKETPLACE BID (score>=85, tier 1-2): ${bidCandidates.length}`);
for (const { r, hit } of bidCandidates.slice(0, 15)) {
  console.log(`  ${String(r.fit_score).padStart(3)} [${hit.market}] ${r.title.slice(0, 74)}`);
}

const unknown = byTier.get(0) ?? 0;
console.log(`\nunknown rate: ${pct(unknown)} — these stay eligible, never vetoed`);
console.log(`veto rate   : ${pct(byTier.get(3) ?? 0)}\n`);
