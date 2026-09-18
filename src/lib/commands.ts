/**
 * Slash commands sent to the bot. The kill switch lives here, so it has to work
 * even when the rest of the pipeline is misbehaving — every handler is a single
 * state write or a single read, with no dependency on the LLM or the feeds.
 */

import { sql, getState, setState, bidBudget, guard } from "./db.js";
import { sendPlain } from "./telegram.js";

export async function handleCommand(text: string): Promise<string> {
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, "");

  switch (cmd) {
    case "/pause": {
      await setState("enabled", false);
      await sendPlain("Paused. Nothing will be sent or queued until /resume.");
      return "paused";
    }

    case "/resume": {
      await setState("enabled", true);
      const g = await guard();
      await sendPlain(
        `Resumed. Mode: ${g.reason}.` +
        (g.send ? "" : "\nStill in dry run — generating but not sending."),
      );
      return "resumed";
    }

    case "/status": {
      const g = await guard();
      const [c] = (await sql`
        SELECT count(*) FILTER (WHERE fit_score >= 85 AND lane='approve'
                                  AND coalesce(market_tier,0) <> 3)::int AS bid_ready,
               count(*) FILTER (WHERE fit_score >= 65 AND lane='auto'
                                  AND coalesce(market_tier,0) <> 3)::int AS outreach_ready,
               count(*)::int AS total
        FROM listings
      `) as any[];
      const [p] = (await sql`
        SELECT count(*) FILTER (WHERE status='pending_approval')::int AS pending,
               count(*) FILTER (WHERE status='approved')::int          AS approved,
               count(*) FILTER (WHERE status='skipped')::int           AS skipped
        FROM proposals
      `) as any[];
      const fl = await bidBudget("freelancer");
      const uw = await bidBudget("upwork");

      await sendPlain([
        `Mode: ${g.reason}`,
        ``,
        `Listings: ${c.total} total`,
        `  bid-ready (85+, approve lane): ${c.bid_ready}`,
        `  outreach-ready (65+, auto lane): ${c.outreach_ready}`,
        ``,
        `Proposals: ${p.pending} pending, ${p.approved} approved, ${p.skipped} skipped`,
        ``,
        `Budget this month:`,
        `  Freelancer: ${fl.left}/${fl.allowance} bids`,
        `  Upwork: ${uw.left}/${uw.allowance} connects`,
      ].join("\n"));
      return "status";
    }

    case "/pending": {
      const rows = (await sql`
        SELECT p.id, l.title, l.fit_score, l.source
        FROM proposals p JOIN listings l ON l.id = p.listing_id
        WHERE p.status = 'pending_approval'
        ORDER BY l.fit_score DESC LIMIT 15
      `) as any[];
      await sendPlain(
        rows.length
          ? `${rows.length} awaiting your decision:\n\n` +
            rows.map((r) => `#${r.id}  [${r.fit_score}] ${r.title.slice(0, 60)}\n      ${r.source}`).join("\n")
          : "Nothing pending.",
      );
      return "pending";
    }

    case "/cap": {
      // /cap 10  -> set the daily Lane A ceiling
      const n = Number(text.split(/\s+/)[1]);
      if (!Number.isFinite(n) || n < 0 || n > 200) {
        await sendPlain("Usage: /cap <0-200>   (daily Lane A send ceiling)");
        return "cap_invalid";
      }
      await setState("daily_cap_auto", n);
      await sendPlain(`Lane A daily cap set to ${n}.`);
      return "cap_set";
    }

    case "/help":
    case "/start": {
      await sendPlain([
        "freelance-engine",
        "",
        "/status   mode, listing counts, proposal counts, bid budget",
        "/pending  proposals awaiting your decision",
        "/cap N    set the daily Lane A send ceiling",
        "/pause    stop all sending and queueing",
        "/resume   undo /pause",
        "",
        "Approval cards arrive at 06:00 WAT.",
        "Marketplace proposals are never auto-submitted - you press Send on the platform.",
      ].join("\n"));
      return "help";
    }

    default:
      await sendPlain(`Unknown command: ${cmd}\nTry /help`);
      return "unknown";
  }
}

/** Exposed for the status line in other tasks. */
export async function pendingCount(): Promise<number> {
  const [r] = (await sql`
    SELECT count(*)::int AS n FROM proposals WHERE status = 'pending_approval'
  `) as { n: number }[];
  return r?.n ?? 0;
}

export { getState };
