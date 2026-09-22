/**
 * Run the auto-release sweep immediately instead of waiting for the next
 * 15-minute tick.
 *
 *   tsx scripts/release-now.ts
 *
 * Same code path the scheduled task uses. Sends any batch whose deadline has
 * passed; a batch on Hold (auto_release_at NULL) is left alone.
 */

import "dotenv/config";
import { guard } from "../src/lib/db.js";
import { releaseDueBatches } from "../src/lib/decisions.js";

const g = await guard();
console.log(`guard: send=${g.send} (${g.reason})\n`);

const r = await releaseDueBatches((s) => console.log(s));

console.log(
  r.released
    ? `\nreleased ${r.released} batch(es)`
    : "\nnothing due — no pending batch is past its deadline",
);
