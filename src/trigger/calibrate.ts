import { schedules, logger } from "@trigger.dev/sdk";
import { sql } from "../lib/db.js";
import { send as tg, esc } from "../lib/telegram.js";

/**
 * Weekly review: what actually got replies versus what went silent.
 *
 * This is the compounding loop. Without it reply rate plateaus; with it, the
 * scoring weights and source mix move toward whatever is genuinely converting.
 * It reports and recommends — it does not silently retune itself, because a
 * scoring change the user cannot see is a scoring change nobody can debug.
 */
export const calibrate = schedules.task({
  id: "calibrate",
  cron: { pattern: "0 18 * * 0", timezone: "Africa/Lagos" },
  run: async () => {
    const bySource = (await sql`
      SELECT l.source,
             count(*)::int                                            AS sent,
             count(r.id)::int                                         AS replies,
             count(*) FILTER (WHERE r.category = 'interview_request')::int AS interviews
      FROM sends s
      JOIN proposals p ON p.id = s.proposal_id
      JOIN listings  l ON l.id = p.listing_id
      LEFT JOIN replies r ON r.send_id = s.id
      WHERE s.sent_at > now() - interval '7 days' AND s.dry_run = false
      GROUP BY l.source
      ORDER BY replies DESC, sent DESC
    `) as { source: string; sent: number; replies: number; interviews: number }[];

    const [totals] = (await sql`
      SELECT count(*)::int AS sent,
             count(r.id)::int AS replies,
             count(*) FILTER (WHERE r.category = 'interview_request')::int AS interviews
      FROM sends s
      LEFT JOIN replies r ON r.send_id = s.id
      WHERE s.sent_at > now() - interval '7 days' AND s.dry_run = false
    `) as { sent: number; replies: number; interviews: number }[];

    const rate = totals.sent ? (100 * totals.replies) / totals.sent : 0;

    const lines = [
      `*Weekly calibration*`,
      `Sent *${totals.sent}* · Replies *${totals.replies}* · Interviews *${totals.interviews}*`,
      `Reply rate *${esc(rate.toFixed(1))}%*`,
      ``,
    ];

    if (bySource.length) {
      lines.push(`*By source*`);
      for (const s of bySource.slice(0, 8)) {
        const r = s.sent ? ((100 * s.replies) / s.sent).toFixed(0) : "0";
        lines.push(`${esc(s.source)}: ${s.replies}/${s.sent} \\(${esc(r)}%\\)`);
      }
      lines.push(``);
    }

    // Thresholds are advisory. 5% is the floor below which the problem is the
    // proposal or the profile, not the targeting.
    if (totals.sent === 0) {
      lines.push(`_No live sends this week — still in dry run, or paused._`);
    } else if (rate < 5) {
      lines.push(
        `⚠️ Reply rate below 5%\\. The usual cause at this stage is a cold profile ` +
        `with no reviews, not bad targeting\\. Highest-leverage fix: attach a ` +
        `60-second demo built for the client's stated problem\\.`,
      );
    } else if (rate > 15) {
      lines.push(`✅ Above 15% — raise the asking rate on the next batch\\.`);
    }

    const dead = bySource.filter((s) => s.sent >= 10 && s.replies === 0);
    if (dead.length) {
      lines.push(``, `Zero replies from: ${esc(dead.map((d) => d.source).join(", "))} — consider dropping\\.`);
    }

    await tg(lines.join("\n"));
    logger.info("calibration complete", { ...totals, replyRate: rate });
    return { ...totals, replyRate: rate, bySource };
  },
});
