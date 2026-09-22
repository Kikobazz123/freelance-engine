/**
 * Read-only snapshot of the live pipeline: guard state, today's cap usage, how
 * many contactable candidates are left, and the most recent real sends.
 *
 *   tsx scripts/status.ts
 */
import "dotenv/config";
import { sql, guard, getState, sentToday } from "../src/lib/db.js";

const g = await guard();
const cap = await getState<number>("daily_cap_auto", 10);
const already = await sentToday("auto");

const [cand] = (await sql`
  SELECT count(*)::int AS n FROM listings l
  WHERE l.lane='auto' AND l.contact_email IS NOT NULL AND l.fit_score >= 65
    AND coalesce(l.market_tier,0) <> 3
    AND NOT ('abuse' = ANY(l.red_flags)) AND NOT ('unpaid' = ANY(l.red_flags))
    AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email = l.contact_email)
    AND NOT EXISTS (SELECT 1 FROM sends sn WHERE sn.to_address = l.contact_email AND sn.dry_run=false)
`) as any[];

const sends = (await sql`
  SELECT to_address, sent_at FROM sends
  WHERE dry_run = false AND lane = 'auto'
  ORDER BY sent_at DESC LIMIT 15`) as any[];

console.log(`guard        : send=${g.send} (${g.reason})`);
console.log(`daily cap    : ${cap}`);
console.log(`sent today   : ${already}`);
console.log(`slots left   : ${Math.max(0, cap - already)}`);
console.log(`uncontacted  : ${cand.n} eligible candidates`);
// Is the scheduler alive? Each Inngest job writes a heartbeat when it finishes.
const beats = (await sql`
  SELECT key, value, updated_at FROM pipeline_state
  WHERE key LIKE 'cron:%' ORDER BY updated_at DESC
`) as { key: string; value: { ok: boolean; detail: string }; updated_at: string | Date }[];
console.log(`\nscheduled jobs (last run):`);
if (!beats.length) console.log("  none yet — no scheduled job has completed since heartbeats were added");
for (const b of beats) {
  const t = b.updated_at instanceof Date ? b.updated_at : new Date(b.updated_at);
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  console.log(`  ${b.key.replace("cron:", "").padEnd(14)} ${b.value?.ok ? "ok    " : "FAILED"} ` +
    `${mins < 90 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`}  ${String(b.value?.detail ?? "").slice(0, 60)}`);
}

console.log(`\nlive sends so far:`);
for (const s of sends) {
  const t = s.sent_at instanceof Date ? s.sent_at.toISOString() : String(s.sent_at);
  console.log(`  ${t}  ${s.to_address}`);
}
