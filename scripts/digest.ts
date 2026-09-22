/**
 * Stage a batch of Lane A drafts and post the rundown to Telegram.
 *
 *   tsx scripts/digest.ts              stage up to 20, post the rundown
 *   tsx scripts/digest.ts --max 10     stage up to 10
 *   tsx scripts/digest.ts --dry        compose and store, print locally, post nothing
 *   tsx scripts/digest.ts --repost ID  re-post the rundown for an existing batch
 *   tsx scripts/digest.ts --release ID arm an existing batch to auto-send now
 *
 * Sends no email. The batch sits as drafts until you press Approve on the card,
 * which is handled by scripts/approvals.ts (or the scheduled poller).
 *
 * The number staged here is the number one tap will send, which is the whole
 * safety model: you read the rundown, the count on the button matches what you
 * read, and nothing else can creep in between.
 */

import "dotenv/config";
import { stageBatch, loadBatch } from "../src/lib/drafts.js";
import { postDigest } from "../src/lib/digest.js";
import { guard, sql } from "../src/lib/db.js";

const argv = process.argv.slice(2);
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);

const repost = flag("--repost");
const release = flag("--release");
const dry = argv.includes("--dry");
const max = Number(flag("--max") ?? 20);

if (!Number.isInteger(max) || max <= 0 || max > 100) {
  console.error("--max needs an integer between 1 and 100");
  process.exit(1);
}

const g = await guard();
console.log(`guard: send=${g.send} (${g.reason})\n`);

if (release) {
  // Arms a batch that predates the deadline, or one that was held and should
  // now go. The auto-release task picks it up on its next tick.
  const r = (await sql`
    UPDATE digests SET auto_release_at = now()
    WHERE batch_id = ${release} AND status = 'pending'
    RETURNING batch_id, n_drafts
  `) as { batch_id: string; n_drafts: number }[];
  if (!r.length) {
    console.error(`no pending batch ${release} (already decided, or no such batch)`);
    process.exit(1);
  }
  console.log(`armed ${r[0].batch_id}: ${r[0].n_drafts} draft(s) will send on the next release tick`);
  console.log(`run it now with:  tsx scripts/release-now.ts`);
  process.exit(0);
}

if (repost) {
  const drafts = await loadBatch(repost);
  if (!drafts.length) { console.error(`no such batch: ${repost}`); process.exit(1); }
  const r = await postDigest(repost);
  console.log(`re-posted batch ${repost}: ${r.sendable} ready, ${r.blocked} blocked`);
  process.exit(0);
}

console.log(`staging up to ${max} drafts…\n`);
const { batchId, staged, blocked } = await stageBatch(max, (s) => console.log(s));

console.log(`\nbatch ${batchId}: ${staged} staged, ${blocked} blocked`);

if (!staged && !blocked) {
  console.log("nothing to review — no new candidates.");
  process.exit(0);
}

if (dry) {
  console.log("\n--dry: nothing posted to Telegram. Review locally:\n");
  for (const d of await loadBatch(batchId)) {
    console.log(`--- ${d.status.toUpperCase()}  ${d.to_address}  (fit ${d.fit_score})`);
    console.log(`    ${d.title}`);
    console.log(`    ${d.url}`);
    if (d.blocked_reason) console.log(`    BLOCKED: ${d.blocked_reason}`);
    else console.log(`\n${d.salutation}\n${d.body}\n`);
  }
  console.log(`\nre-post later with:  tsx scripts/digest.ts --repost ${batchId}`);
  process.exit(0);
}

const r = await postDigest(batchId);
console.log(`\nposted ${r.messages} message(s) to Telegram.`);
console.log(`Press "Approve all ${r.sendable} & send" on the card.`);
console.log(`Run  npm run approvals  so the press registers instantly.`);
