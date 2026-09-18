import { schedules, logger } from "@trigger.dev/sdk";
import { readFileSync, existsSync } from "node:fs";
import { sql, guard, getState, sentToday } from "../lib/db.js";
import { gmailSend } from "../lib/gmail.js";
import { composeApplication, isStub, type Target } from "../lib/outreach.js";
import { validateClaims } from "../lib/claims.js";
import { send as tg, esc } from "../lib/telegram.js";

/**
 * Lane A — send applications to addresses the poster published asking to be
 * contacted.
 *
 * Seven independent gates stand between a listing and an outbound email. They are
 * separate on purpose: this is the only part of the system that can reach a real
 * stranger, and a single flag is one typo away from being wrong.
 *
 *   1. guard()            dry_run / enabled, from the DB and the env
 *   2. suppression        anyone who asked not to be contacted
 *   3. one-per-address    a unique index in the DB, not just a query
 *   4. daily cap          bounded blast radius if anything upstream misfires
 *   5. no stubs           an unusable LLM must not produce an empty email
 *   6. claim validation   no technology, location or outcome the profile cannot
 *                         support. Two fabrications appeared in the first dry run
 *                         ("LangChain", "available in NYC") and a prompt alone
 *                         will not reliably stop them.
 *   7. gmailSend(dryRun)  short-circuits before the network regardless
 */

const CV_PATH = "cv/Lordmark-Dorgu-AI-Automation-Engineer.pdf";

export const sendLaneA = schedules.task({
  id: "send-lane-a",
  cron: { pattern: "45 5 * * *", timezone: "Africa/Lagos" },
  maxDuration: 300,
  run: async () => {
    const g = await guard();
    const cap = await getState<number>("daily_cap_auto", 25);
    const remaining = Math.max(0, cap - (await sentToday("auto")));

    if (remaining === 0) {
      logger.info("daily cap reached", { cap });
      return { sent: 0, skipped: 0, reason: "cap reached" };
    }

    // Candidates: scored, non-vetoed, has a published contact, never written to,
    // and not suppressed. The NOT EXISTS clauses are the durable part — the
    // unique index below is the backstop if two runs race.
    const rows = (await sql`
      SELECT l.id, l.title, l.company, l.url, l.source, l.contact_email,
             l.fit_score, l.stack_tags, p.id AS proposal_id, p.body AS proposal_body
      FROM listings l
      LEFT JOIN proposals p ON p.listing_id = l.id
      WHERE l.lane = 'auto'
        AND l.contact_email IS NOT NULL
        AND l.fit_score >= 65
        AND coalesce(l.market_tier, 0) <> 3
        AND NOT ('abuse'  = ANY(l.red_flags))
        AND NOT ('unpaid' = ANY(l.red_flags))
        AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email = l.contact_email)
        AND NOT EXISTS (
          SELECT 1 FROM sends sn
          WHERE sn.to_address = l.contact_email AND sn.dry_run = false
        )
      ORDER BY l.fit_score DESC
      LIMIT ${remaining}
    `) as any[];

    // One address can appear on several listings; write once per address per run.
    const seen = new Set<string>();
    const batch = rows.filter((r) => {
      if (seen.has(r.contact_email)) return false;
      seen.add(r.contact_email);
      return true;
    });

    const cv = existsSync(CV_PATH)
      ? {
          filename: "Lordmark-Dorgu-AI-Automation-Engineer.pdf",
          contentType: "application/pdf",
          data: readFileSync(CV_PATH),
        }
      : undefined;
    if (!cv) logger.warn("CV not found, sending without attachment", { path: CV_PATH });

    let sent = 0, held = 0, failed = 0, stubbed = 0, rejected = 0;

    for (const r of batch) {
      const target: Target = {
        title: r.title, company: r.company, url: r.url, source: r.source,
        contact_email: r.contact_email, fit_score: r.fit_score,
        stack_tags: r.stack_tags,
      };

      let subject: string, body: string;
      try {
        const composed = await composeApplication(target);
        subject = composed.subject;
        body = composed.body;
      } catch (e) {
        logger.warn("compose failed", { id: r.id, error: String((e as Error).message).slice(0, 160) });
        failed++;
        continue;
      }

      // Gate 5: a stub is not an email. Never send one, dry run or not.
      if (isStub(body)) {
        logger.warn("stub body, refusing to send", { id: r.id });
        stubbed++;
        continue;
      }

      // Gate 6: block anything the profile cannot back up. A fabricated stack or
      // a made-up location is worse than not applying at all — it fails on the
      // call and burns the contact.
      const violations = validateClaims(body);
      if (violations.length) {
        logger.warn("unsupported claims, refusing to send", {
          id: r.id, to: r.contact_email,
          violations: violations.map((x) => `${x.kind}:${x.found}`),
        });
        rejected++;
        continue;
      }

      // Gate 1 + 7. The guard decides; gmailSend enforces it again independently.
      const dry = !g.send;
      try {
        const res = await gmailSend({
          to: r.contact_email, subject, body, dryRun: dry, attachment: cv,
        });

        await sql`
          INSERT INTO sends (proposal_id, lane, channel, to_address,
                             provider_msg_id, gmail_thread_id, dry_run)
          VALUES (${r.proposal_id ?? null}, 'auto', ${r.source}, ${r.contact_email},
                  ${res?.id ?? null}, ${res?.threadId ?? null}, ${dry})
        `;
        dry ? held++ : sent++;
      } catch (e) {
        const msg = String((e as Error).message).slice(0, 160);
        // Gate 3's backstop: the unique index rejects a duplicate address even if
        // the NOT EXISTS above raced with a concurrent run.
        if (/sends_addr_once|duplicate key/i.test(msg)) {
          logger.info("already written to this address", { to: r.contact_email });
          held++;
        } else {
          logger.error("send failed", { to: r.contact_email, error: msg });
          failed++;
        }
      }
    }

    await tg([
      `*Lane A*`,
      g.send ? `Sent: *${sent}*` : `Held \\(dry run\\): *${held}*`,
      ...(failed ? [`Failed: ${failed}`] : []),
      ...(stubbed ? [`Stubbed, not sent: ${stubbed}`] : []),
      ...(rejected ? [`Blocked by claim check: ${rejected}`] : []),
      `Candidates: ${batch.length} · cap remaining ${remaining}`,
      `Mode: ${esc(g.reason)}`,
    ].join("\n"));

    logger.info("lane A complete", { sent, held, failed, stubbed, rejected, mode: g.reason });
    return { sent, held, failed, stubbed, rejected, mode: g.reason };
  },
});
