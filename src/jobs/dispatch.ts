import {
  sql, guard, getState, sentToday, bidBudget, platformOf, type Platform,
} from "../lib/db.js";
import { approvalCard, send as tg, esc } from "../lib/telegram.js";

/**
 * Route drafted proposals to one of two lanes.
 *
 *   Lane A (auto)    — email-apply boards and direct outreach. No platform is
 *                      involved, so no platform terms are engaged. THIS IS THE
 *                      ENGINE on a free tier.
 *   Lane B (approve) — Freelancer / Upwork. NOTHING is sent. The proposal is
 *                      queued to Telegram and the user presses Send themselves.
 *
 * Lane B exists because Upwork's terms permanently ban tools that submit without
 * a human click. There is deliberately no code path in this repo that posts to a
 * marketplace, and scripts/verify.ts asserts that structurally.
 *
 * Lane B is additionally *rationed*. Free tier is 6 Freelancer bids and 10 Upwork
 * Connects per month — roughly 8 bids total, a month's supply of which the corpus
 * currently offers ~21 candidates. So the bar is score >= 85 and a non-Tier-3
 * market, and every card shows what is left.
 */

const LANE_B_MIN_SCORE = 85;

/** Upwork charges a variable number of Connects; assume the common case and show it. */
const ASSUMED_CONNECT_COST = 8;

export type Log = (msg: string, data?: unknown) => void;

/**
 * Job body, runner-agnostic. Called by the Inngest function (src/inngest) and,
 * until the cutover is complete, by the Trigger.dev wrapper in src/trigger.
 */
export async function runDispatch(log: Log = () => {}) {
    const g = await guard();
    const capAuto = await getState<number>("daily_cap_auto", 25);

    const remainingAuto = Math.max(0, capAuto - (await sentToday("auto")));

    const drafts = (await sql`
      SELECT p.id AS proposal_id, p.body, p.rate_quoted,
             l.id AS listing_id, l.title, l.company, l.url, l.source, l.lane,
             l.fit_score, l.market, coalesce(l.market_tier, 0) AS market_tier
      FROM proposals p
      JOIN listings l ON l.id = p.listing_id
      WHERE p.status = 'draft'
      ORDER BY l.rank_score DESC NULLS LAST, l.fit_score DESC
    `) as any[];

    let queued = 0, sent = 0, held = 0, budgetBlocked = 0, belowBar = 0;
    const budgets = new Map<Platform, { left: number; unit: string; allowance: number }>();

    // ---- Lane B: ration, then queue for a human click. Never auto-sent.
    for (const d of drafts.filter((x) => x.lane === "approve")) {
      if (d.fit_score < LANE_B_MIN_SCORE || d.market_tier === 3) { belowBar++; continue; }

      const platform = platformOf(d.source);
      if (platform) {
        if (!budgets.has(platform)) {
          const b = await bidBudget(platform);
          budgets.set(platform, { left: b.left, unit: b.unit, allowance: b.allowance });
        }
        const b = budgets.get(platform)!;
        const cost = platform === "upwork" ? ASSUMED_CONNECT_COST : 1;
        if (b.left < cost) { budgetBlocked++; continue; }
        // Reserve optimistically; the callback handler confirms or releases it.
        b.left -= cost;
      }

      const b = platform ? budgets.get(platform)! : null;
      const card = await approvalCard({
        proposalId: d.proposal_id,
        title: d.title,
        company: d.company ?? "",
        source: d.source,
        score: d.fit_score,
        rate: d.rate_quoted ? `$${d.rate_quoted}/hr` : "—",
        url: d.url,
        preview: d.body,
        market: d.market ?? "unknown",
        budgetNote: b
          ? `${b.left} of ${b.allowance} ${b.unit}${b.allowance === 1 ? "" : "s"} left this month`
          : "free to apply",
      });
      // Store the message coordinates so the callback handler can edit this exact
      // card in place once it is decided, rather than posting a loose reply.
      await sql`
        UPDATE proposals
        SET status = 'pending_approval',
            telegram_chat_id = ${card.chat.id},
            telegram_message_id = ${card.message_id}
        WHERE id = ${d.proposal_id}
      `;
      queued++;
    }

    // ---- Lane A: auto-send once the guard clears. Tier 3 still vetoed.
    for (const d of drafts.filter((x) => x.lane === "auto").slice(0, remainingAuto)) {
      if (d.market_tier === 3) { belowBar++; continue; }
      if (!g.send) {
        await sql`
          INSERT INTO sends (proposal_id, lane, channel, dry_run)
          VALUES (${d.proposal_id}, 'auto', ${d.source}, true)
        `;
        held++;
        continue;
      }
      // Live Lane A sending lands in send-email.ts. Until then the guard keeps
      // this unreachable rather than silently pretending to have sent.
      log("lane A live send not yet wired", { proposalId: d.proposal_id });
      held++;
    }

    const budgetLines = [...budgets].map(
      ([p, b]) => `${esc(p)}: ${b.left}/${b.allowance} ${esc(b.unit)}s left`,
    );

    await tg([
      `*Morning dispatch*`,
      `Queued for approval: *${queued}*`,
      `Lane A ${g.send ? "sent" : "held"}: *${g.send ? sent : held}*`,
      ...(budgetBlocked ? [`Budget exhausted, skipped: ${budgetBlocked}`] : []),
      ...(budgetLines.length ? ["", ...budgetLines] : []),
      ``,
      `Mode: ${esc(g.reason)}`,
    ].join("\n"));

    log("dispatch complete", {
      queued, sent, held, budgetBlocked, belowBar, mode: g.reason,
    });
    return { queued, sent, held, budgetBlocked, belowBar, mode: g.reason };
}
