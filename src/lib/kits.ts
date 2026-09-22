/**
 * Apply kits: a finished cover letter and the apply link, for jobs that take
 * applications through a form.
 *
 * Of 213 eligible, high-fit jobs in one 30-day window, only 20 published an
 * email address. The rest are good matches behind Greenhouse, Lever, Ashby or a
 * company's own form — email cannot reach them, and submitting those forms
 * automatically would breach the sites' terms. So the engine does everything
 * except the click: it picks the job, checks eligibility, writes and validates
 * the letter, and posts it to Telegram. He opens the link, pastes, submits, and
 * taps "I applied". That tap is the confirmation, and it is recorded.
 *
 * There is deliberately no code path here that fetches or posts to an apply
 * form. The card carries a link and text; a human does the rest.
 */

import { sql, getState } from "./db.js";
import { composeApplication, isStub, type Target } from "./outreach.js";
import { validateClaims } from "./claims.js";
import { salutationFor, formLetter } from "./letter.js";
import { sendPlain, editPlain, answerCallback, type Button } from "./telegram.js";
import { MIN_SEND_FIT } from "./drafts.js";

export type Kit = {
  id: number; listing_id: string; body: string; status: string;
  title: string; company: string | null; url: string; source: string;
  fit_score: number; location: string | null;
  telegram_chat_id: number | null; telegram_message_id: number | null;
};

/**
 * Jobs worth a kit: the same bar as email (auto lane, fit >= 65, nothing
 * vetoed), seen in the last 30 days, with NO address — anything with an
 * address goes through the email lane instead — and never kitted before.
 * Freshest high-fit first, because early applicants are read first.
 */
export async function kitCandidates(limit: number) {
  return (await sql`
    SELECT l.id, l.title, l.company, l.url, l.source, l.fit_score, l.stack_tags,
           l.description, l.location
    FROM listings l
    WHERE l.lane = 'auto'
      AND l.contact_email IS NULL
      AND l.fit_score >= ${MIN_SEND_FIT}
      AND coalesce(l.market_tier, 0) <> 3
      AND NOT ('abuse' = ANY(l.red_flags)) AND NOT ('unpaid' = ANY(l.red_flags))
      AND l.last_seen_at > now() - interval '30 days'
      AND l.url ~ '^https?://'
      AND NOT EXISTS (SELECT 1 FROM apply_kits k WHERE k.listing_id = l.id)
    ORDER BY l.fit_score DESC, coalesce(l.posted_at, l.first_seen_at) DESC
    LIMIT ${limit}
  `) as any[];
}

/** Write and validate kits. Posts nothing. A letter failing the guard is kept as 'blocked'. */
export async function buildKits(
  limit: number, log: (s: string) => void = () => {},
): Promise<{ built: number; blocked: number; ids: number[] }> {
  let built = 0, blocked = 0;
  const ids: number[] = [];
  for (const r of await kitCandidates(limit)) {
    const c = await composeApplication({ ...r, contact_email: "" } as Target);
    let status = "pending";
    let reason: string | null = null;
    if (isStub(c.body)) { status = "blocked"; reason = "no LLM provider available"; }
    else {
      const v = validateClaims(c.body);
      if (v.length) { status = "blocked"; reason = v.map((x) => x.found).join(", "); }
    }
    const body = status === "pending"
      ? formLetter(salutationFor(r.company, ""), c.body)
      : c.body;
    const [row] = (await sql`
      INSERT INTO apply_kits (listing_id, body, status, blocked_reason)
      VALUES (${r.id}, ${body}, ${status}, ${reason})
      ON CONFLICT (listing_id) DO NOTHING
      RETURNING id
    `) as { id: number }[];
    if (!row) continue;
    if (status === "blocked") { blocked++; log(`  BLOCKED ${r.title.slice(0, 50)}  (${reason})`); }
    else { built++; ids.push(row.id); log(`  KIT     fit ${r.fit_score}  ${r.title.slice(0, 60)}`); }
  }
  return { built, blocked, ids };
}

export const kitButtons = (id: number): Button[][] => [[
  { text: "✅ I applied", callback_data: `ka:${id}` },
  { text: "⏭ Skip", callback_data: `ks:${id}` },
]];

export function kitText(k: Kit): string {
  return [
    `APPLY KIT #${k.id} — fit ${k.fit_score}`,
    `${k.company ? `${k.company} — ` : ""}${k.title.replace(/\s+/g, " ").slice(0, 90)}`,
    `${k.source}${k.location ? ` · ${k.location.slice(0, 60)}` : ""}`,
    ``,
    `1. Open: ${k.url}`,
    `2. Paste the cover letter below, attach your CV, submit.`,
    `3. Tap "I applied" so it is recorded.`,
    ``,
    `— COVER LETTER —`,
    k.body,
  ].join("\n");
}

async function loadKit(id: number): Promise<Kit | null> {
  const rows = (await sql`
    SELECT k.id, k.listing_id, k.body, k.status, k.telegram_chat_id, k.telegram_message_id,
           l.title, l.company, l.url, l.source, l.fit_score, l.location
    FROM apply_kits k JOIN listings l ON l.id = k.listing_id
    WHERE k.id = ${id}
  `) as Kit[];
  return rows[0] ?? null;
}

/** Post one card per pending kit, with a header so the morning batch reads as a set. */
export async function postKits(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  await sendPlain(
    `APPLY KITS — ${ids.length} job${ids.length === 1 ? "" : "s"} that take applications by form\n` +
    `Each has a ready cover letter. Submit on the site, then tap "I applied".\n` +
    `(Email-apply jobs are sent separately in the batch digest.)`,
  );
  let posted = 0;
  for (const id of ids) {
    const k = await loadKit(id);
    if (!k || k.status !== "pending") continue;
    const card = await sendPlain(kitText(k), kitButtons(k.id));
    await sql`
      UPDATE apply_kits SET telegram_chat_id = ${card.chat.id}, telegram_message_id = ${card.message_id}
      WHERE id = ${id}
    `;
    posted++;
  }
  return posted;
}

async function repaint(k: Kit, banner: string, button: string) {
  if (!k.telegram_chat_id || !k.telegram_message_id) return;
  try {
    await editPlain(
      Number(k.telegram_chat_id), Number(k.telegram_message_id),
      `${banner}\n${k.company ? `${k.company} — ` : ""}${k.title.replace(/\s+/g, " ").slice(0, 90)}\n${k.url}`,
      [[{ text: button, callback_data: `noopk:${k.id}` }]],
    );
  } catch (e) {
    console.warn(`kit card edit failed: ${String((e as Error).message).slice(0, 100)}`);
  }
}

/**
 * "I applied" — the confirmation. Idempotent: the conditional UPDATE is the
 * lock, so a double tap or a redelivered update records one application.
 */
export async function markApplied(cbId: string, id: number): Promise<string> {
  const won = (await sql`
    UPDATE apply_kits SET status = 'applied', decided_at = now()
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `) as { id: number }[];
  const k = await loadKit(id);
  if (!k) { await answerCallback(cbId, "Kit not found", true); return "not_found"; }
  if (!won.length) { await answerCallback(cbId, `Already ${k.status}`, true); return `already_${k.status}`; }

  // Recorded alongside the emails so reply and conversion stats see both lanes.
  await sql`
    INSERT INTO sends (lane, channel, dry_run) VALUES ('form', ${k.source}, false)
  `;
  const when = new Date().toLocaleString("en-GB", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
  await answerCallback(cbId, "Recorded — application confirmed");
  await repaint(k, `✅ APPLIED — confirmed ${when} WAT`, "✅ Applied");
  return "applied";
}

export async function skipKit(cbId: string, id: number): Promise<string> {
  const won = (await sql`
    UPDATE apply_kits SET status = 'skipped', decided_at = now()
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `) as { id: number }[];
  const k = await loadKit(id);
  if (!k) { await answerCallback(cbId, "Kit not found", true); return "not_found"; }
  if (!won.length) { await answerCallback(cbId, `Already ${k.status}`, true); return `already_${k.status}`; }
  await answerCallback(cbId, "Skipped");
  await repaint(k, "⏭ SKIPPED", "⏭ Skipped");
  return "skipped";
}

/**
 * Withdraw posted kits whose job no longer qualifies.
 *
 * Rules tighten after a kit is posted — "U.S.-Based Software Developer" was
 * kitted before the US-only pattern learned that spelling. A kit is a request
 * for two minutes of his time, so one that can no longer succeed is withdrawn
 * and its card repainted, rather than left looking like work to do.
 */
export async function retireIneligibleKits(): Promise<number> {
  const rows = (await sql`
    SELECT k.id, l.score_why FROM apply_kits k JOIN listings l ON l.id = k.listing_id
    WHERE k.status = 'pending' AND coalesce(l.fit_score, 0) < ${MIN_SEND_FIT}
  `) as { id: number; score_why: string | null }[];
  for (const r of rows) {
    await sql`
      UPDATE apply_kits SET status = 'skipped', decided_at = now(),
        blocked_reason = ${`withdrawn: ${r.score_why ?? "no longer qualifies"}`}
      WHERE id = ${r.id} AND status = 'pending'
    `;
    const k = await loadKit(Number(r.id));
    if (k) {
      const why = (r.score_why ?? "").replace(/^VETO:/, "").replace(/[_-]/g, " ");
      await repaint(k, `⏹ WITHDRAWN — no longer eligible (${why || "rules changed"}). No need to apply.`, "⏹ Withdrawn");
    }
  }
  return rows.length;
}

/** Today's kit budget: daily_cap_kits minus kits already posted today. */
export async function kitRoom(): Promise<number> {
  const cap = await getState<number>("daily_cap_kits", 8);
  const [r] = (await sql`
    SELECT count(*)::int AS n FROM apply_kits
    WHERE telegram_message_id IS NOT NULL
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')
  `) as { n: number }[];
  return Math.max(0, cap - (r?.n ?? 0));
}
