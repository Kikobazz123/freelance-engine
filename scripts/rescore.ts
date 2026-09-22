/**
 * Re-score listings with the current rules. Use after changing scoring.ts, so
 * existing rows do not keep scores computed under old rules.
 *
 *   tsx scripts/rescore.ts              everything seen in the last 30 days
 *   tsx scripts/rescore.ts --days 60
 */

import "dotenv/config";
import { getState } from "../src/lib/db.js";
import { rescoreListings } from "../src/lib/rescore.js";

const argv = process.argv.slice(2);
const days = Number(argv.includes("--days") ? argv[argv.indexOf("--days") + 1] : 30);
const floor = await getState<number>("rate_floor_hourly", 35);

const r = await rescoreListings({ sinceDays: days, floor });
console.log(`rescored ${r.scored} listings from the last ${days} days: ` +
  `${r.changed} changed score, ${r.vetoed} now vetoed`);
