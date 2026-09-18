import { schedules, logger } from "@trigger.dev/sdk";
import { sql } from "../lib/db.js";
import { gmailSearch, gmailGet } from "../lib/gmail.js";
import { send as tg, esc } from "../lib/telegram.js";

/**
 * Watch for client replies, classify them, and alert on the ones that matter.
 *
 * Classification is keyword-based, not LLM-based: it runs every 30 minutes and
 * the cost of a wrong call is only a mis-sorted alert. Anything it cannot place
 * lands in `unclear`, which still notifies — a missed interview request is far
 * more expensive than a false alarm.
 */

const RULES: [RegExp, "interview_request" | "info_request" | "rejection" | "spam"][] = [
  [/\b(unsubscribe|newsletter|promotion|no[- ]reply|noreply)\b/i, "spam"],
  [/\b(unfortunately|not (?:moving|proceeding)|decided to (?:go|move) (?:with|forward)|other candidates|no longer (?:available|open)|filled)\b/i, "rejection"],
  [/\b(interview|call|meeting|chat|zoom|google meet|calendar|schedule|availability|book a time|hop on)\b/i, "interview_request"],
  [/\b(portfolio|rate|quote|proposal|timeline|scope|tell me more|questions?|references?|sample)\b/i, "info_request"],
];

function classify(text: string) {
  for (const [re, cat] of RULES) if (re.test(text)) return cat;
  return "unclear" as const;
}

export const inboxWatch = schedules.task({
  id: "inbox-watch",
  cron: { pattern: "0 8-20/2 * * *", timezone: "Africa/Lagos" },
  run: async () => {
    // Only threads we actually wrote to — avoids scanning the whole mailbox.
    const threads = (await sql`
      SELECT DISTINCT gmail_thread_id
      FROM sends
      WHERE gmail_thread_id IS NOT NULL
        AND dry_run = false
        AND sent_at > now() - interval '45 days'
    `) as { gmail_thread_id: string }[];

    if (!threads.length) {
      logger.info("no tracked threads yet");
      return { checked: 0, new: 0 };
    }

    let found = 0, notified = 0;
    for (const { gmail_thread_id } of threads) {
      const msgs = await gmailSearch(`thread:${gmail_thread_id} -from:me`);
      for (const m of msgs) {
        const existing = (await sql`
          SELECT 1 FROM replies WHERE gmail_msg_id = ${m.id}
        `) as unknown[];
        if (existing.length) continue;

        const full = await gmailGet(m.id);
        const category = classify(`${full.subject} ${full.snippet}`);

        const [row] = (await sql`
          INSERT INTO replies (
            send_id, gmail_msg_id, gmail_thread_id, from_address, subject, snippet, category
          )
          SELECT s.id, ${m.id}, ${gmail_thread_id}, ${full.from}, ${full.subject},
                 ${full.snippet}, ${category}
          FROM sends s
          WHERE s.gmail_thread_id = ${gmail_thread_id}
          LIMIT 1
          ON CONFLICT (gmail_msg_id) DO NOTHING
          RETURNING id
        `) as { id: number }[];
        found++;

        // Spam and rejections are recorded but never interrupt the user.
        if (category === "spam" || category === "rejection") continue;

        await tg([
          category === "interview_request" ? `🔥 *INTERVIEW REQUEST*` : `📩 *${esc(category)}*`,
          `From: ${esc(full.from)}`,
          `Subject: ${esc(full.subject)}`,
          ``,
          esc(full.snippet.slice(0, 400)),
        ].join("\n"));

        if (row?.id) {
          await sql`UPDATE replies SET notified_at = now() WHERE id = ${row.id}`;
        }
        notified++;
      }
    }

    logger.info("inbox scan complete", { threads: threads.length, found, notified });
    return { checked: threads.length, new: found, notified };
  },
});
