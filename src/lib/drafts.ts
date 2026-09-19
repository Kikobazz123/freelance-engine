/**
 * Staged Lane A drafts: compose and validate now, send later on one approval.
 *
 * Lane A used to compose an email and put it on the wire in the same function
 * call. That works, but it means no human ever sees an email before its
 * recipient does — and the claim validator, good as it is, only catches claims
 * it has patterns for. Staging inserts the one thing that was missing: a moment
 * where the whole batch can be read.
 *
 * The compliance boundary is unchanged and unchanged-able. This module sends
 * email to addresses that were published asking for applicants. It has no
 * marketplace code path, and scripts/verify.ts asserts that structurally for the
 * whole repo.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql, guard } from "./db.js";
import { gmailSend } from "./gmail.js";
import { composeApplication, isStub, SENDER_NAME, type Target } from "./outreach.js";
import { validateClaims } from "./claims.js";
import { salutationFor, htmlLetter, textLetter } from "./letter.js";

export type Draft = {
  id: number;
  batch_id: string;
  listing_id: string;
  to_address: string;
  subject: string;
  salutation: string;
  body: string;
  status: string;
  blocked_reason: string | null;
  /* joined from listings, for the rundown */
  title: string;
  company: string | null;
  url: string;
  source: string;
  fit_score: number;
  market: string | null;
};

const CV_PATH = "cv/Lordmark-Dorgu-AI-Automation-Engineer.pdf";

/** A short, sortable, human-readable batch id: 20260918-3f9a. */
function newBatchId(): string {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${d}-${randomUUID().slice(0, 4)}`;
}

/**
 * Candidates for a new batch.
 *
 * Excludes, in order: no address, below the bar, Tier 3 market, abusive or
 * unpaid postings, opted out, already contacted for real, and already sitting
 * in an open batch. That last one is why staging twice is safe.
 */
async function candidates(limit: number) {
  return (await sql`
    SELECT l.id, l.title, l.company, l.url, l.source, l.contact_email, l.fit_score,
           l.stack_tags, l.market
    FROM listings l
    WHERE l.lane = 'auto' AND l.contact_email IS NOT NULL AND l.fit_score >= 65
      AND coalesce(l.market_tier, 0) <> 3
      AND NOT ('abuse' = ANY(l.red_flags)) AND NOT ('unpaid' = ANY(l.red_flags))
      AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email = l.contact_email)
      AND NOT EXISTS (
        SELECT 1 FROM sends sn WHERE sn.to_address = l.contact_email AND sn.dry_run = false)
      AND NOT EXISTS (
        SELECT 1 FROM outreach_drafts d
        WHERE d.to_address = l.contact_email AND d.status IN ('draft', 'approved'))
    ORDER BY l.fit_score DESC
    LIMIT ${limit}
  `) as any[];
}

/**
 * Compose, validate and persist a batch. Sends nothing.
 *
 * A draft that fails validation is stored as 'blocked' rather than dropped, so
 * the rundown can show what was rejected and why. Silently vanishing candidates
 * is how you end up wondering why the numbers do not add up.
 */
export async function stageBatch(
  limit: number,
  log: (s: string) => void = () => {},
): Promise<{ batchId: string; staged: number; blocked: number }> {
  const rows = await candidates(limit);
  const batchId = newBatchId();

  let staged = 0, blocked = 0;
  const seen = new Set<string>();

  for (const r of rows) {
    if (seen.has(r.contact_email)) continue;
    seen.add(r.contact_email);

    const c = await composeApplication(r as Target);

    let status = "draft";
    let reason: string | null = null;

    if (isStub(c.body)) {
      status = "blocked";
      reason = "no LLM provider available";
    } else {
      const v = validateClaims(c.body);
      if (v.length) {
        status = "blocked";
        reason = v.map((x) => x.found).join(", ");
      }
    }

    await sql`
      INSERT INTO outreach_drafts
        (batch_id, listing_id, to_address, subject, salutation, body, status,
         blocked_reason, provider)
      VALUES (${batchId}, ${r.id}, ${r.contact_email}, ${c.subject},
              ${salutationFor(r.company, r.contact_email)}, ${c.body}, ${status},
              ${reason}, ${c.provider})
      ON CONFLICT (batch_id, to_address) DO NOTHING
    `;

    if (status === "blocked") {
      blocked++;
      log(`  BLOCKED ${r.contact_email.padEnd(32)} ${reason}`);
    } else {
      staged++;
      log(`  DRAFT   ${r.contact_email.padEnd(32)} fit ${r.fit_score}`);
    }
  }

  await sql`
    INSERT INTO digests (batch_id, n_drafts) VALUES (${batchId}, ${staged})
    ON CONFLICT (batch_id) DO UPDATE SET n_drafts = EXCLUDED.n_drafts
  `;

  return { batchId, staged, blocked };
}

/** Every draft in a batch, sendable and blocked alike, best fit first. */
export async function loadBatch(batchId: string): Promise<Draft[]> {
  return (await sql`
    SELECT d.id, d.batch_id, d.listing_id, d.to_address, d.subject, d.salutation,
           d.body, d.status, d.blocked_reason,
           l.title, l.company, l.url, l.source, l.fit_score, l.market
    FROM outreach_drafts d
    JOIN listings l ON l.id = d.listing_id
    WHERE d.batch_id = ${batchId}
    ORDER BY (d.status = 'blocked'), l.fit_score DESC
  `) as Draft[];
}

/** The most recent batch that still has something to decide. */
export async function latestOpenBatch(): Promise<string | null> {
  const rows = (await sql`
    SELECT batch_id FROM digests WHERE status IN ('pending', 'sending')
    ORDER BY created_at DESC LIMIT 1
  `) as { batch_id: string }[];
  return rows[0]?.batch_id ?? null;
}

/**
 * Send every approved draft in a batch.
 *
 * Deliberately re-reads the guard rather than trusting the caller: this is the
 * function that puts bytes on the wire, and it is reachable from a button press,
 * a script and a scheduled task. It is also idempotent — the unique index on
 * sends(to_address) means a re-run after a crash cannot double-contact anyone,
 * and a draft is only marked 'sent' after the send returns.
 */
export async function sendBatch(
  batchId: string,
  log: (s: string) => void = () => {},
): Promise<{ sent: number; failed: number; skipped: number }> {
  const g = await guard();
  if (!g.send) throw new Error(`refusing to send: ${g.reason}`);

  const drafts = (await sql`
    SELECT d.id, d.to_address, d.subject, d.salutation, d.body, l.source
    FROM outreach_drafts d
    JOIN listings l ON l.id = d.listing_id
    WHERE d.batch_id = ${batchId} AND d.status = 'approved'
    ORDER BY l.fit_score DESC
  `) as any[];

  const cv = {
    filename: "Lordmark-Dorgu-AI-Automation-Engineer.pdf",
    contentType: "application/pdf",
    data: readFileSync(CV_PATH),
  };

  let sent = 0, failed = 0, skipped = 0;

  for (const d of drafts) {
    // Someone may have opted out, or been reached another way, between approval
    // and here. Cheap to check, and the alternative is a complaint.
    const sup = (await sql`
      SELECT 1 FROM suppression WHERE email = ${d.to_address}
      UNION ALL
      SELECT 1 FROM sends WHERE to_address = ${d.to_address} AND dry_run = false
      LIMIT 1
    `) as any[];
    if (sup.length) {
      await sql`UPDATE outreach_drafts SET status = 'skipped' WHERE id = ${d.id}`;
      log(`  SKIP    ${d.to_address} (suppressed or already contacted)`);
      skipped++;
      continue;
    }

    try {
      const res = await gmailSend({
        to: d.to_address,
        subject: d.subject,
        body: textLetter(d.salutation, d.body),
        html: htmlLetter(d.salutation, d.body),
        fromName: SENDER_NAME,
        dryRun: false,
        attachment: cv,
      });
      await sql`
        INSERT INTO sends (lane, channel, to_address, provider_msg_id, gmail_thread_id, dry_run)
        VALUES ('auto', ${d.source}, ${d.to_address}, ${res?.id ?? null},
                ${res?.threadId ?? null}, false)
      `;
      await sql`
        UPDATE outreach_drafts
        SET status = 'sent', sent_at = now(),
            provider_msg_id = ${res?.id ?? null}, gmail_thread_id = ${res?.threadId ?? null}
        WHERE id = ${d.id}
      `;
      log(`  SENT    ${d.to_address}`);
      sent++;
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 160);
      await sql`
        UPDATE outreach_drafts SET status = 'failed', blocked_reason = ${msg}
        WHERE id = ${d.id}
      `;
      log(`  FAILED  ${d.to_address}  ${msg}`);
      failed++;
    }
  }

  return { sent, failed, skipped };
}
