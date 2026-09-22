/**
 * Run email discovery over high-fit listings that have no address.
 *
 *   tsx scripts/discover.ts --sample 15 --dry   measure the hit rate, write nothing
 *   tsx scripts/discover.ts --limit 40          discover and record results
 *
 * --dry exists because the plan's rule is to measure before enabling: report
 * the real hit rate on a sample, then decide.
 */

import "dotenv/config";
import { sql } from "../src/lib/db.js";
import { discoverListings } from "../src/lib/discover-run.js";

const argv = process.argv.slice(2);
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const dry = argv.includes("--dry");
const limit = Number(flag("--sample") ?? flag("--limit") ?? 40);

const r = await discoverListings(limit, { dry, log: (s) => console.log(s) });

console.log(
  `\n${dry ? "DRY — nothing written. " : ""}` +
  `probed ${r.probed} · found ${r.found} (${r.probed ? Math.round((100 * r.found) / r.probed) : 0}%)` +
  ` · via posting ${r.viaPosting} · via careers page ${r.viaCareers}`,
);
console.log(`misses: ${JSON.stringify(r.reasons)}`);

if (!dry) {
  const [c] = (await sql`
    SELECT count(*)::int AS n FROM listings
    WHERE contact_source LIKE 'page:%'
  `) as { n: number }[];
  console.log(`addresses found by discovery so far: ${c.n}`);
}
