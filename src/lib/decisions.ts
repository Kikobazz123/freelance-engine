/**
 * Approve / skip / show-full-text handling for the Telegram approval cards.
 *
 * Every handler is idempotent. A poll can be retried (trigger.config sets
 * maxAttempts 3), and Telegram itself redelivers an update until the offset is
 * acknowledged — so the same button press WILL arrive twice sooner or later.
 * Deciding twice must not spend two bids out of a monthly budget of six.
 *
 * Idempotency is enforced by a conditional UPDATE: the status transition only
 * fires from 'pending_approval', and the budget is only touched when that
 * transition actually returned a row.
 */

import { sql, bidBudget, spendBid, platformOf, guard, type Platform } from "./db.js";
import { answerCallback, editMessage, sendPlain, esc } from "./telegram.js";

const CONNECT_COST = 8; // Upwork proposals cost 4-16; assume the common case.

type Row = {
  id: number; body: string; rate_quoted: number | null; status: string;
  title: string; url: string; source: string; fit_score: number;
  telegram_chat_id: number | null; telegram_message_id: number | null;
  bid_platform: string | null; bid_cost: number;
};

async function load(proposalId: number): Promise<Row | null> {
  const rows = (await sql`
    SELECT p.id, p.body, p.rate_quoted, p.status,
           p.telegram_chat_id, p.telegram_message_id, p.bid_platform, p.bid_cost,
           l.title, l.url, l.source, l.fit_score
    FROM proposals p JOIN listings l ON l.id = p.listing_id
    WHERE p.id = ${proposalId}
  `) as Row[];
  return rows[0] ?? null;
}

/** Rewrite the card in place; never fatal, the decision is already recorded. */
async function markCard(r: Row, banner: string, extra = "") {
  if (!r.telegram_chat_id || !r.telegram_message_id) return;
  try {
    await editMessage(
      r.telegram_chat_id, r.telegram_message_id,
      [`${banner}`, `*${esc(r.title.slice(0, 80))}*`,
       `${esc(r.source)} · fit ${r.fit_score}`,
       ...(extra ? [``, esc(extra)] : []),
       ``, `[Open listing](${r.url})`].join("\n"),
    );
  } catch (e) {
    // Telegram refuses an edit if the text is byte-identical, and a card older
    // than 48h cannot be edited at all. Neither changes what was decided — but
    // log it, because a silent catch here once hid the card never updating.
    console.warn(`markCard failed: ${String((e as Error).message).slice(0, 120)}`);
  }
}

export async function approve(cbId: string, proposalId: number): Promise<string> {
  const r = await load(proposalId);
  if (!r) { await answerCallback(cbId, "Proposal not found", true); return "not_found"; }

  if (r.status !== "pending_approval") {
    await answerCallback(cbId, `Already ${r.status}`, true);
    return `already_${r.status}`;
  }

  const platform = platformOf(r.source) as Platform | null;
  const cost = platform === "upwork" ? CONNECT_COST : platform ? 1 : 0;

  // Refuse rather than overspend. The budget is the whole point of the lane.
  if (platform) {
    const b = await bidBudget(platform);
    if (b.left < cost) {
      await answerCallback(
        cbId, `No budget left: ${b.left}/${b.allowance} ${b.unit}s this month`, true);
      return "no_budget";
    }
  }

  // Conditional transition IS the lock. If a duplicate press raced us, this
  // returns zero rows and the budget below is never touched.
  const won = (await sql`
    UPDATE proposals
    SET status = 'approved', decided_at = now(),
        bid_platform = ${platform}, bid_cost = ${cost}
    WHERE id = ${proposalId} AND status = 'pending_approval'
    RETURNING id
  `) as { id: number }[];

  if (!won.length) {
    await answerCallback(cbId, "Already handled", true);
    return "race_lost";
  }

  if (platform) await spendBid(platform, cost);

  const g = await guard();
  await sql`
    INSERT INTO sends (proposal_id, lane, channel, dry_run)
    VALUES (${proposalId}, 'approve', ${r.source}, ${!g.send})
  `;

  const left = platform ? (await bidBudget(platform)).left : null;
  const note = platform
    ? `Spent ${cost} ${platform === "upwork" ? "connect" : "bid"}${cost === 1 ? "" : "s"}. ${left} left this month.`
    : `Free to apply — no budget spent.`;

  await answerCallback(cbId, "Approved — full text sent below");
  await markCard(r, "✅ *APPROVED*", note);

  // Plain text, unescaped, so it can be copied straight into the platform.
  await sendPlain(
    `APPROVED — paste this into ${r.source}\n` +
    `Rate: $${r.rate_quoted ?? "?"}/hr\n` +
    `${r.url}\n\n${r.body}`,
  );

  return "approved";
}

export async function skip(cbId: string, proposalId: number): Promise<string> {
  const r = await load(proposalId);
  if (!r) { await answerCallback(cbId, "Proposal not found", true); return "not_found"; }

  if (r.status !== "pending_approval") {
    await answerCallback(cbId, `Already ${r.status}`, true);
    return `already_${r.status}`;
  }

  const won = (await sql`
    UPDATE proposals SET status = 'skipped', decided_at = now()
    WHERE id = ${proposalId} AND status = 'pending_approval'
    RETURNING id
  `) as { id: number }[];

  if (!won.length) { await answerCallback(cbId, "Already handled", true); return "race_lost"; }

  await answerCallback(cbId, "Skipped");
  await markCard(r, "⏭ *SKIPPED*");
  return "skipped";
}

/**
 * Send the untruncated proposal. Deliberately does NOT change status — the card
 * stays actionable, because wanting to read the full text is not a decision.
 */
export async function fullText(cbId: string, proposalId: number): Promise<string> {
  const r = await load(proposalId);
  if (!r) { await answerCallback(cbId, "Proposal not found", true); return "not_found"; }
  await answerCallback(cbId, "Full text below");
  await sendPlain(
    `FULL TEXT (not yet approved)\n${r.title}\n${r.url}\n` +
    `Rate: $${r.rate_quoted ?? "?"}/hr\n\n${r.body}`,
  );
  return "full_text";
}

export async function handleCallback(
  cb: { id: string; data: string },
): Promise<{ action: string; result: string }> {
  const [verb, rawId] = cb.data.split(":");
  const id = Number(rawId);
  if (!Number.isFinite(id)) {
    await answerCallback(cb.id, "Malformed button");
    return { action: verb, result: "bad_id" };
  }
  // proposalId 0 is the test card from scripts/send-test-card.ts.
  if (id === 0) {
    await answerCallback(cb.id, "Test card — not a real proposal", true);
    return { action: verb, result: "test_card" };
  }
  switch (verb) {
    case "ap": return { action: "approve", result: await approve(cb.id, id) };
    case "sk": return { action: "skip", result: await skip(cb.id, id) };
    case "ed": return { action: "full_text", result: await fullText(cb.id, id) };
    default:
      await answerCallback(cb.id, "Unknown action");
      return { action: verb, result: "unknown" };
  }
}
