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
import { sendBatch } from "./drafts.js";
import { updateCard, approvedButton, controlText, controlButtons } from "./digest.js";

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

/* ------------------------------------------------------- whole-batch actions */

/**
 * Approve and send an entire Lane A batch on one press.
 *
 * Ordering matters more than it looks. The card is rewritten to its decided
 * state BEFORE the sending starts, because sending a dozen emails takes a
 * minute or two and a button that sits there unchanged for that long reads as
 * broken — which is exactly the bug that made a decision "recorded and
 * completely invisible" once already. So: take the lock, acknowledge, repaint
 * the card, then do the slow work and repaint again with the result.
 *
 * The conditional UPDATE to 'sending' is the lock. A double press, or a
 * redelivered update, finds the row already moved and does nothing.
 */
export async function approveAll(cbId: string, batchId: string): Promise<string> {
  const rows = (await sql`
    SELECT status, n_drafts FROM digests WHERE batch_id = ${batchId}
  `) as { status: string; n_drafts: number }[];
  if (!rows.length) { await answerCallback(cbId, "Batch not found", true); return "not_found"; }
  if (rows[0].status !== "pending") {
    await answerCallback(cbId, `Batch already ${rows[0].status}`, true);
    return `already_${rows[0].status}`;
  }

  const r = await executeBatch(batchId, {
    auto: false,
    onLocked: (n) => answerCallback(cbId, `Approved — sending ${n}`),
  });

  if (r === "race_lost") await answerCallback(cbId, "Already handled", true);
  if (r.startsWith("held")) await answerCallback(cbId, r.replace("held:", "Held: "), true);
  return r;
}

/**
 * Take the batch and send it. The single implementation behind both the button
 * and the deadline.
 *
 * Ordering matters more than it looks. The card is rewritten to its decided
 * state BEFORE the sending starts, because sending a dozen emails takes a
 * minute or two and a button that sits there unchanged for that long reads as
 * broken — which is exactly the bug that made a decision "recorded and
 * completely invisible" once already.
 *
 * The conditional UPDATE to 'sending' is the lock, so the button and the
 * deadline racing each other is harmless: whichever arrives second finds the
 * row already moved and does nothing.
 */
export async function executeBatch(
  batchId: string,
  opts: { auto: boolean; onLocked?: (n: number) => Promise<unknown> } = { auto: true },
): Promise<string> {
  const won = (await sql`
    UPDATE digests
    SET status = 'sending', decided_at = now(), auto_released = ${opts.auto}
    WHERE batch_id = ${batchId} AND status = 'pending'
    RETURNING batch_id, n_drafts
  `) as { batch_id: string; n_drafts: number }[];
  if (!won.length) return "race_lost";

  const g = await guard();
  if (!g.send) {
    // Put it back so a later run can pick it up once the brake is off.
    await sql`
      UPDATE digests SET status = 'pending', decided_at = NULL, auto_released = false
      WHERE batch_id = ${batchId}
    `;
    return `held:${g.reason}`;
  }

  const n = won[0].n_drafts;
  const banner = opts.auto ? "✅ AUTO-SENT" : "✅ APPROVED";
  await opts.onLocked?.(n);

  // Instant, before any email goes out.
  await updateCard(
    batchId,
    `BATCH ${batchId}\n\n${banner}\n\nSending ${n} application${n === 1 ? "" : "s"} now…`,
    approvedButton(batchId),
  );

  await sql`
    UPDATE outreach_drafts SET status = 'approved', decided_at = now()
    WHERE batch_id = ${batchId} AND status = 'draft'
  `;

  let result: { sent: number; failed: number; skipped: number };
  try {
    result = await sendBatch(batchId);
  } catch (e) {
    await sql`UPDATE digests SET status = 'sent' WHERE batch_id = ${batchId}`;
    await updateCard(
      batchId,
      `BATCH ${batchId}\n\n${banner}\n\nSending failed: ` +
      String((e as Error).message).slice(0, 200),
      approvedButton(batchId),
    );
    return "send_error";
  }

  await sql`UPDATE digests SET status = 'sent' WHERE batch_id = ${batchId}`;
  await updateCard(
    batchId,
    [
      `BATCH ${batchId}`,
      ``,
      `${banner} — ${result.sent} sent`,
      ...(opts.auto ? [`(not reviewed in time, released automatically)`] : []),
      ...(result.failed ? [`${result.failed} failed`] : []),
      ...(result.skipped ? [`${result.skipped} skipped (opted out or already contacted)`] : []),
      ``,
      `Each went as a letter with your CV attached.`,
      `Replies will be flagged here automatically.`,
    ].join("\n"),
    approvedButton(batchId),
  );

  return `sent_${result.sent}`;
}

/**
 * Release every batch whose deadline has passed.
 *
 * Shared by the scheduled task and the CLI so there is exactly one definition
 * of "due". A held batch has auto_release_at NULL and is tested for explicitly.
 */
export async function releaseDueBatches(
  log: (s: string) => void = () => {},
): Promise<{ released: number; results: Record<string, string> }> {
  const g = await guard();
  if (!g.send) {
    log(`holding, not releasing: ${g.reason}`);
    return { released: 0, results: {} };
  }

  const due = (await sql`
    SELECT batch_id, n_drafts FROM digests
    WHERE status = 'pending'
      AND auto_release_at IS NOT NULL
      AND auto_release_at <= now()
      AND n_drafts > 0
    ORDER BY created_at
  `) as { batch_id: string; n_drafts: number }[];

  const results: Record<string, string> = {};
  for (const d of due) {
    try {
      results[d.batch_id] = await executeBatch(d.batch_id, { auto: true });
    } catch (e) {
      // One bad batch must not strand the others.
      results[d.batch_id] = `error: ${String((e as Error).message).slice(0, 120)}`;
    }
    log(`  ${d.batch_id} (${d.n_drafts} drafts) -> ${results[d.batch_id]}`);
  }
  return { released: due.length, results };
}

/**
 * Cancel the deadline without deciding anything.
 *
 * The batch stays pending and keeps its Approve and Skip buttons; it just stops
 * being on a clock. For when you want to read it properly this evening and must
 * not have it go out meanwhile.
 */
export async function holdBatch(cbId: string, batchId: string): Promise<string> {
  const won = (await sql`
    UPDATE digests SET auto_release_at = NULL
    WHERE batch_id = ${batchId} AND status = 'pending'
    RETURNING n_drafts
  `) as { n_drafts: number }[];

  if (!won.length) {
    await answerCallback(cbId, "Too late — that batch is already decided", true);
    return "not_pending";
  }

  await answerCallback(cbId, "Held — this will not send on its own");
  await updateCard(
    batchId,
    controlText(batchId, won[0].n_drafts, 0, null),
    controlButtons(batchId, won[0].n_drafts).slice(0, 1), // keep Approve/Skip, drop Hold
  );
  return "held";
}

/** Discard a whole batch without sending any of it. */
export async function skipAll(cbId: string, batchId: string): Promise<string> {
  const won = (await sql`
    UPDATE digests SET status = 'skipped', decided_at = now()
    WHERE batch_id = ${batchId} AND status = 'pending'
    RETURNING batch_id
  `) as { batch_id: string }[];
  if (!won.length) { await answerCallback(cbId, "Already handled", true); return "race_lost"; }

  const n = (await sql`
    UPDATE outreach_drafts SET status = 'skipped', decided_at = now()
    WHERE batch_id = ${batchId} AND status = 'draft'
    RETURNING id
  `) as { id: number }[];

  await answerCallback(cbId, `Skipped ${n.length}`);
  await updateCard(
    batchId,
    `BATCH ${batchId}\n\n⏭ SKIPPED — ${n.length} draft${n.length === 1 ? "" : "s"} discarded.\n` +
    `Nothing was sent. Those listings stay in the pool for a later batch.`,
    [[{ text: "⏭ Skipped", callback_data: `noop:${batchId}` }]],
  );
  return `skipped_${n.length}`;
}

export async function handleCallback(
  cb: { id: string; data: string },
): Promise<{ action: string; result: string }> {
  // Batch verbs carry a batch id, not a numeric proposal id.
  const [v0, ...restParts] = cb.data.split(":");
  const rest = restParts.join(":");
  if (v0 === "all")  return { action: "approve_all", result: await approveAll(cb.id, rest) };
  if (v0 === "nall") return { action: "skip_all",    result: await skipAll(cb.id, rest) };
  if (v0 === "hold") return { action: "hold",        result: await holdBatch(cb.id, rest) };
  if (v0 === "noop") {
    // The single button a decided card is left with. Confirms, changes nothing.
    const rows = (await sql`
      SELECT status FROM digests WHERE batch_id = ${rest}
    `) as { status: string }[];
    await answerCallback(cb.id, `Batch ${rows[0]?.status ?? "decided"} — nothing left to do`, true);
    return { action: "noop", result: rows[0]?.status ?? "unknown" };
  }

  // Everything else is a single-proposal verb carrying a numeric id.
  const id = Number(rest);
  if (!Number.isFinite(id)) {
    await answerCallback(cb.id, "Malformed button");
    return { action: v0, result: "bad_id" };
  }
  // proposalId 0 is the test card from scripts/send-test-card.ts.
  if (id === 0) {
    await answerCallback(cb.id, "Test card — not a real proposal", true);
    return { action: v0, result: "test_card" };
  }
  switch (v0) {
    case "ap": return { action: "approve", result: await approve(cb.id, id) };
    case "sk": return { action: "skip", result: await skip(cb.id, id) };
    case "ed": return { action: "full_text", result: await fullText(cb.id, id) };
    default:
      await answerCallback(cb.id, "Unknown action");
      return { action: v0, result: "unknown" };
  }
}
