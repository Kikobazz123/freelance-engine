/**
 * The rundown: every draft in a batch, readable in one pass, with one button
 * that sends all of them.
 *
 * Written as plain text rather than MarkdownV2 on purpose. The rundown is mostly
 * listing URLs, and MarkdownV2 requires escaping `-` `.` `(` `)` `_` and more —
 * one missed character and Telegram 400s the entire message. Telegram auto-links
 * bare URLs in plain text, so this gets clickable links and cannot fail to
 * render.
 */

import { sql } from "./db.js";
import { sendPlain, editPlain, type Button } from "./telegram.js";
import { loadBatch, type Draft } from "./drafts.js";

/** Telegram's hard limit is 4096; leave room for the chunk header. */
const CHUNK = 3500;

/** How much of each body to show inline. Enough to judge, short enough to scan. */
const PREVIEW = 420;

const line = (s: string) => s.replace(/\s+/g, " ").trim();

/** One entry in the rundown. The URL is the reference back to the real posting. */
function entry(d: Draft, n: number): string {
  const head = `${n}. ${line(d.title).slice(0, 70)}`;
  const meta = [
    d.company ? line(d.company).slice(0, 40) : null,
    d.source,
    `fit ${d.fit_score}`,
    d.market ?? "unknown",
  ].filter(Boolean).join(" · ");

  if (d.status === "blocked") {
    return [
      head,
      `   ${meta}`,
      `   ${d.url}`,
      `   BLOCKED — ${d.blocked_reason}. Not staged, nothing will be sent.`,
    ].join("\n");
  }

  const body = d.body.length > PREVIEW ? d.body.slice(0, PREVIEW).trimEnd() + "…" : d.body;
  return [
    head,
    `   ${meta}`,
    `   to: ${d.to_address}`,
    `   ${d.url}`,
    ``,
    `   "${d.salutation}"`,
    body.split("\n").map((l) => `   ${l}`).join("\n"),
  ].join("\n");
}

/** Pack entries into as few messages as Telegram will accept. */
function chunk(entries: string[]): string[] {
  const out: string[] = [];
  let buf = "";
  for (const e of entries) {
    // An entry longer than a whole chunk gets its own message, truncated.
    const piece = e.length > CHUNK ? e.slice(0, CHUNK - 3) + "…" : e;
    if (buf && buf.length + piece.length + 2 > CHUNK) {
      out.push(buf);
      buf = piece;
    } else {
      buf = buf ? `${buf}\n\n${piece}` : piece;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** How long an unreviewed batch waits before it sends itself. */
export const AUTO_RELEASE_HOURS = 6;

export function controlButtons(batchId: string, n: number): Button[][] {
  return [
    [
      { text: `✅ Approve all ${n} & send`, callback_data: `all:${batchId}` },
      { text: "⏭ Skip all", callback_data: `nall:${batchId}` },
    ],
    // Hold cancels the deadline without deciding anything, for the case where
    // you want to read properly later and must not have it sent meanwhile.
    [{ text: "⏸ Hold (cancel auto-send)", callback_data: `hold:${batchId}` }],
  ];
}

/** The single button a decided card is left with. Reports state, changes nothing. */
export const approvedButton = (batchId: string): Button[][] =>
  [[{ text: "✅ Approved", callback_data: `noop:${batchId}` }]];

export function controlText(
  batchId: string, sendable: number, blocked: number, releaseHours: number | null = AUTO_RELEASE_HOURS,
): string {
  return [
    `BATCH ${batchId}`,
    ``,
    `${sendable} draft${sendable === 1 ? "" : "s"} ready to send` +
      (blocked ? `, ${blocked} blocked by the claim checker` : ""),
    ``,
    `All of these are direct email to addresses the employer published.`,
    `Marketplace proposals are never in here — those stay on their own cards,`,
    `because Upwork bans tools that submit without a human click.`,
    ``,
    `One tap sends all ${sendable}, each as a letter with your CV attached.`,
    releaseHours === null
      ? `On hold — this will NOT send on its own.`
      : `If you don't tap, these send automatically in ${releaseHours}h.`,
  ].join("\n");
}

/**
 * Post the rundown, then the control card last so the buttons sit at the bottom
 * of the chat where your thumb already is.
 *
 * Returns the control card's coordinates, stored so a button press can edit that
 * exact message rather than posting a loose reply.
 */
export async function postDigest(batchId: string): Promise<{
  messages: number; sendable: number; blocked: number;
}> {
  const drafts = await loadBatch(batchId);
  const sendable = drafts.filter((d) => d.status === "draft");
  const blocked = drafts.filter((d) => d.status === "blocked");

  /*
   * A batch with nothing sendable gets no card.
   *
   * Two mornings in a row posted an empty digest with no button, which is pure
   * noise — and worse, it looked like the pipeline had produced something. Say
   * nothing when there is nothing, and log it instead. The blocked-only case
   * gets one short line, because a draft rejected by the claim checker IS worth
   * knowing about, but it is not a decision to make.
   */
  if (!sendable.length) {
    if (blocked.length) {
      await sendPlain(
        `Batch ${batchId}: nothing sendable. ${blocked.length} draft` +
        `${blocked.length === 1 ? " was" : "s were"} blocked by the claim checker ` +
        `(${[...new Set(blocked.map((d) => d.blocked_reason))].join(", ")}). Nothing to approve.`,
      );
    }
    await sql`UPDATE digests SET status = 'skipped', decided_at = now() WHERE batch_id = ${batchId}`;
    return { messages: blocked.length ? 1 : 0, sendable: 0, blocked: blocked.length };
  }

  const header =
    `DRAFTS FOR REVIEW — batch ${batchId}\n` +
    `${sendable.length} ready` + (blocked.length ? `, ${blocked.length} blocked` : "") +
    `\nRead through, then use the buttons at the bottom.`;

  await sendPlain(header);

  // Number only the sendable ones, so "12 of 15" in the rundown matches the
  // count on the button. Blocked entries are listed after, unnumbered.
  const parts = chunk([
    ...sendable.map((d, i) => entry(d, i + 1)),
    ...(blocked.length ? ["— BLOCKED, NOT SENDING —"] : []),
    ...blocked.map((d, i) => entry(d, i + 1)),
  ]);

  for (const p of parts) await sendPlain(p);

  const card = await sendPlain(
    controlText(batchId, sendable.length, blocked.length),
    controlButtons(batchId, sendable.length),
  );

  await sql`
    UPDATE digests
    SET telegram_chat_id = ${card.chat.id}, telegram_message_id = ${card.message_id},
        n_drafts = ${sendable.length},
        auto_release_at = now() + (${AUTO_RELEASE_HOURS} || ' hours')::interval
    WHERE batch_id = ${batchId}
  `;

  return { messages: parts.length + 2, sendable: sendable.length, blocked: blocked.length };
}

/** Rewrite the control card. Never throws — the decision is already recorded. */
export async function updateCard(
  batchId: string, text: string, buttons: Button[][] = [],
): Promise<void> {
  const rows = (await sql`
    SELECT telegram_chat_id AS chat, telegram_message_id AS msg
    FROM digests WHERE batch_id = ${batchId}
  `) as { chat: number | null; msg: number | null }[];
  const d = rows[0];
  if (!d?.chat || !d?.msg) return;
  try {
    await editPlain(Number(d.chat), Number(d.msg), text, buttons);
  } catch (e) {
    console.warn(`digest card edit failed: ${String((e as Error).message).slice(0, 120)}`);
  }
}
