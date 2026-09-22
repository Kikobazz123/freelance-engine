/**
 * Build and post apply kits for form-only jobs.
 *
 *   tsx scripts/kits.ts              up to today's remaining kit cap
 *   tsx scripts/kits.ts --max 5
 *   tsx scripts/kits.ts --dry        write and store the letters, post nothing
 */

import "dotenv/config";
import { buildKits, postKits, kitRoom, kitCandidates } from "../src/lib/kits.js";

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const maxArg = argv.includes("--max") ? Number(argv[argv.indexOf("--max") + 1]) : null;
const room = maxArg ?? (await kitRoom());

console.log(`eligible form-only jobs waiting: ${(await kitCandidates(500)).length}`);
console.log(`building up to ${room} kit(s)${dry ? " (dry — nothing posted)" : ""}\n`);

const { built, blocked, ids } = await buildKits(room, (s) => console.log(s));
console.log(`\nbuilt ${built}, blocked ${blocked}`);
if (!dry) console.log(`posted ${await postKits(ids)} card(s) to Telegram`);
