/**
 * Send today's Lane A batch immediately, using the same composition, validation
 * and letter formatting the scheduled task uses. Respects the daily cap and
 * every gate; it is the scheduled run, invoked now.
 *
 *   tsx scripts/send-now.ts
 */
import "dotenv/config";
import { IDENTITY } from "../src/config.js";
import { readFileSync } from "node:fs";
import { sql, guard, getState, sentToday } from "../src/lib/db.js";
import { gmailSend } from "../src/lib/gmail.js";
import { composeApplication, isStub, type Target } from "../src/lib/outreach.js";
import { validateClaims } from "../src/lib/claims.js";
import { salutationFor, htmlLetter, textLetter } from "../src/lib/letter.js";
import { sendPlain } from "../src/lib/telegram.js";

const g = await guard();
console.log(`guard: send=${g.send} (${g.reason})`);
if (!g.send) { console.error("held, not sending"); process.exit(1); }

const cap = await getState<number>("daily_cap_auto", 10);
const already = await sentToday("auto");
const remaining = Math.max(0, cap - already);
console.log(`cap ${cap}/day · ${already} already sent today · ${remaining} slots left\n`);
if (remaining === 0) { console.log("daily cap reached"); process.exit(0); }

const rows = (await sql`
  SELECT l.id, l.title, l.company, l.url, l.source, l.contact_email, l.fit_score,
         l.stack_tags, l.market
  FROM listings l
  WHERE l.lane='auto' AND l.contact_email IS NOT NULL AND l.fit_score >= 65
    AND coalesce(l.market_tier,0) <> 3
    AND NOT ('abuse' = ANY(l.red_flags)) AND NOT ('unpaid' = ANY(l.red_flags))
    AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email = l.contact_email)
    AND NOT EXISTS (SELECT 1 FROM sends sn WHERE sn.to_address = l.contact_email AND sn.dry_run=false)
  ORDER BY l.fit_score DESC LIMIT ${remaining}`) as any[];

const seen = new Set<string>();
const batch = rows.filter((r) => !seen.has(r.contact_email) && seen.add(r.contact_email));
const cv = { filename: "cv.pdf",
             contentType: "application/pdf",
             data: readFileSync("cv/cv.pdf") };

let sent = 0, blocked = 0, failed = 0;
const lines: string[] = [];
for (const r of batch) {
  const c = await composeApplication(r as Target);
  if (isStub(c.body)) { console.log(`  STUB    ${r.contact_email}`); blocked++; continue; }
  const v = validateClaims(c.body);
  if (v.length) {
    console.log(`  BLOCKED ${r.contact_email.padEnd(30)} ${v.map((x) => x.found).join(",")}`);
    blocked++; continue;
  }
  const sal = salutationFor(r.company, r.contact_email);
  try {
    const res = await gmailSend({
      to: r.contact_email, subject: c.subject,
      body: textLetter(sal, c.body), html: htmlLetter(sal, c.body),
      fromName: IDENTITY.name, dryRun: false, attachment: cv,
    });
    await sql`INSERT INTO sends (lane, channel, to_address, provider_msg_id, gmail_thread_id, dry_run)
              VALUES ('auto', ${r.source}, ${r.contact_email}, ${res?.id ?? null}, ${res?.threadId ?? null}, false)`;
    console.log(`  SENT    ${r.contact_email.padEnd(30)} fit ${r.fit_score}  ${sal}`);
    lines.push(`${r.contact_email} — ${r.title.slice(0, 44)}`);
    sent++;
  } catch (e) {
    console.log(`  FAILED  ${r.contact_email.padEnd(30)} ${String((e as Error).message).slice(0, 70)}`);
    failed++;
  }
}

const [left] = (await sql`
  SELECT count(*)::int AS n FROM listings l
  WHERE l.lane='auto' AND l.contact_email IS NOT NULL AND l.fit_score>=65
    AND coalesce(l.market_tier,0)<>3
    AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.to_address=l.contact_email AND s.dry_run=false)`) as any[];

console.log(`\nSENT ${sent} · blocked ${blocked} · failed ${failed} · ${left.n} candidates remain uncontacted`);
await sendPlain(
  `${sent} applications sent, formatted as letters with your CV attached:\n\n` +
  lines.map((l) => "  " + l).join("\n") +
  `\n\nDaily cap ${cap} reached. ${left.n} candidates remain for tomorrow.\n` +
  `Replies will be flagged here automatically.`,
);
