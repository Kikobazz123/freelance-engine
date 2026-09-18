/**
 * Run the full pipeline immediately, by hand.
 *
 * Calls the same library code the scheduled tasks call, in the same order — not
 * a simulation of the pipeline, the pipeline itself, invoked now instead of at
 * 05:00. The scheduled runs are unaffected.
 *
 * Lane B approval cards ARE pushed to Telegram. That is safe by construction:
 * nothing on a marketplace is ever auto-submitted, the card just hands over
 * finished text and waits for a human. Lane A composes and validates but does
 * not send.
 *
 *   tsx scripts/run-now.ts [--cards N] [--skip-harvest]
 */

import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  sql, guard, getState, upsertListings, bidBudget, platformOf, type Platform,
} from "../src/lib/db.js";
import { harvestAll } from "../src/lib/sources.js";
import { score } from "../src/lib/scoring.js";
import { writeProposal } from "../src/lib/proposal.js";
import { composeApplication, type Target } from "../src/lib/outreach.js";
import { validateClaims } from "../src/lib/claims.js";
import { approvalCard, send as tg, esc } from "../src/lib/telegram.js";

const argv = process.argv.slice(2);
const CARD_LIMIT = argv.includes("--cards") ? Number(argv[argv.indexOf("--cards") + 1]) : 8;
const skipHarvest = argv.includes("--skip-harvest");

const LANE_B_MIN = 85;
const CONNECT_COST = 8;

const out: string[] = [];
const log = (s = "") => { console.log(s); out.push(s); };

/* ---- gate: this must never be able to become a live run ------------------ */
const g0 = await guard();
log(`# Manual run — ${new Date().toISOString()}`);
log("");
log(`guard: send=${g0.send} — ${g0.reason}`);
if (g0.send) {
  console.error("\nABORT: sending is enabled. A manual run is not the place to go live.");
  console.error("Use the deliberate two-step if that is what you intend.");
  process.exit(1);
}

/* ---- 1. harvest ---------------------------------------------------------- */
if (!skipHarvest) {
  const t0 = Date.now();
  const { rows, report } = await harvestAll();
  const live = report.filter((r) => r.status === "ok").length;
  const { inserted, total } = await upsertListings(rows, { scoreToo: false });
  log(`\n## harvest\n`);
  log(`${live}/${report.length} sources live · ${rows.length} listings · +${inserted} new · ${total} total · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  log(`\n## harvest — skipped\n`);
}

/* ---- 2. score ------------------------------------------------------------ */
const floor = await getState<number>("rate_floor_hourly", 35);
const toScore = (await sql`
  SELECT id, title, tier, stack_tags, red_flags, rate_min, rate_type, posted_at,
         market_tier, market_confidence
  FROM listings
  WHERE fit_score IS NULL OR last_seen_at > now() - interval '2 days'
`) as any[];

for (let i = 0; i < toScore.length; i += 200) {
  const slice = toScore.slice(i, i + 200);
  const params: unknown[] = [];
  const tuples = slice.map((r) => {
    const { score: sc, why } = score({
      title: r.title, tier: r.tier,
      stack_tags: (r.stack_tags ?? []).join("|"),
      red_flags: (r.red_flags ?? []).join("|"),
      rate_min: r.rate_min, rate_type: r.rate_type,
      posted_at: r.posted_at ? new Date(r.posted_at).toISOString() : null,
      market_tier: r.market_tier, market_confidence: r.market_confidence,
    }, floor);
    const b = params.length;
    params.push(r.id, sc, why);
    return `($${b + 1},$${b + 2}::int,$${b + 3})`;
  });
  await sql(
    `UPDATE listings AS l SET fit_score = v.s, score_why = v.w
     FROM (VALUES ${tuples.join(",")}) AS v(id, s, w) WHERE l.id = v.id`, params);
}
const [bands] = (await sql`
  SELECT count(*) FILTER (WHERE fit_score >= 85)::int AS bid,
         count(*) FILTER (WHERE fit_score BETWEEN 65 AND 84)::int AS outreach,
         count(*) FILTER (WHERE fit_score = 0)::int AS vetoed
  FROM listings`) as any[];
log(`\n## score\n`);
log(`scored ${toScore.length} · ${bands.bid} bid-eligible (85+) · ${bands.outreach} outreach (65-84) · ${bands.vetoed} vetoed`);

/* ---- 3 + 4. generate Lane B proposals and push cards --------------------- */
log(`\n## Lane B — approval cards\n`);

const candidates = (await sql`
  SELECT l.id, l.title, l.company, l.url, l.source, l.fit_score, l.market,
         l.stack_tags, l.rate_min, l.rate_max, l.rate_type,
         coalesce(l.market_tier, 0) AS market_tier
  FROM listings l
  LEFT JOIN proposals p ON p.listing_id = l.id
  WHERE p.id IS NULL
    AND l.lane = 'approve'
    AND l.fit_score >= ${LANE_B_MIN}
    AND coalesce(l.market_tier, 0) <> 3
    AND NOT ('abuse' = ANY(l.red_flags))
    AND NOT ('unpaid' = ANY(l.red_flags))
  ORDER BY l.fit_score DESC
  LIMIT ${CARD_LIMIT * 2}
`) as any[];

const budgets = new Map<Platform, { left: number; allowance: number; unit: string }>();
let queued = 0, blockedBudget = 0, blockedClaims = 0;

for (const l of candidates) {
  if (queued >= CARD_LIMIT) break;

  const platform = platformOf(l.source);
  if (platform) {
    if (!budgets.has(platform)) {
      const b = await bidBudget(platform);
      budgets.set(platform, { left: b.left, allowance: b.allowance, unit: b.unit });
    }
    const b = budgets.get(platform)!;
    const cost = platform === "upwork" ? CONNECT_COST : 1;
    if (b.left < cost) { blockedBudget++; continue; }
    b.left -= cost;
  }

  const p = await writeProposal(l);
  const v = validateClaims(p.body);
  if (v.length) {
    log(`- BLOCKED \`${esc(l.source)}\` ${l.title.slice(0, 54)} → ${v.map((x) => x.found).join(", ")}`);
    blockedClaims++;
    continue;
  }

  const [row] = (await sql`
    INSERT INTO proposals (listing_id, body, rate_quoted, cv_variant, model, status)
    VALUES (${l.id}, ${p.body}, ${p.rate}, 'ai-automation-engineer', ${p.model}, 'draft')
    ON CONFLICT (listing_id) DO UPDATE SET body = EXCLUDED.body
    RETURNING id`) as { id: number }[];

  const b = platform ? budgets.get(platform)! : null;
  const card = await approvalCard({
    proposalId: row.id, title: l.title, company: l.company ?? "", source: l.source,
    score: l.fit_score, rate: `$${p.rate}/hr`, url: l.url, preview: p.body,
    market: l.market ?? "unknown",
    budgetNote: b
      ? `${b.left} of ${b.allowance} ${b.unit}s left this month`
      : "free to apply",
  });

  await sql`
    UPDATE proposals
    SET status = 'pending_approval',
        telegram_chat_id = ${card.chat.id}, telegram_message_id = ${card.message_id}
    WHERE id = ${row.id}`;

  log(`- card #${row.id} \`${l.source}\` fit ${l.fit_score} · $${p.rate}/hr · ${l.market ?? "?"} · ${l.title.slice(0, 48)}`);
  queued++;
}
log(`\nqueued **${queued}** cards · ${blockedClaims} blocked by claim check · ${blockedBudget} over budget`);

/* ---- 5. Lane A: compose, validate, HOLD ---------------------------------- */
const g1 = await guard();
if (g1.send) {
  console.error("\nABORT before Lane A: guard changed to sending mid-run.");
  process.exit(1);
}

const cap = await getState<number>("daily_cap_auto", 10);
const laneA = (await sql`
  SELECT title, company, url, source, contact_email, fit_score, stack_tags, market
  FROM listings l
  WHERE lane = 'auto' AND contact_email IS NOT NULL AND fit_score >= 65
    AND coalesce(market_tier, 0) <> 3
    AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email = l.contact_email)
    AND NOT EXISTS (SELECT 1 FROM sends sn WHERE sn.to_address = l.contact_email AND sn.dry_run = false)
  ORDER BY fit_score DESC
  LIMIT ${cap}`) as any[];

log(`\n## Lane A — composed and HELD (nothing sent)\n`);
log(`daily cap ${cap} · ${laneA.length} candidates\n`);

let ok = 0, blocked = 0;
for (const r of laneA) {
  const c = await composeApplication(r as Target);
  const v = validateClaims(c.body);
  if (v.length) blocked++; else ok++;
  log(`### ${r.contact_email}`);
  log(`**${c.subject}**`);
  log(`\`${r.source}\` · fit ${r.fit_score} · ${r.market} · ${c.body.split(/\s+/).length} words`);
  if (v.length) log(`> BLOCKED: ${v.map((x) => `${x.kind}: ${x.found}`).join("; ")}`);
  log("");
  log("```");
  log(c.body);
  log("```");
  log("");
}
log(`${ok} would send · ${blocked} blocked by claim check`);

/* ---- summary ------------------------------------------------------------- */
const [sent] = (await sql`SELECT count(*)::int AS n FROM sends WHERE dry_run = false`) as any[];
const gEnd = await guard();

log(`\n## summary\n`);
log(`| check | result |`);
log(`|---|---|`);
log(`| cards queued to Telegram | ${queued} |`);
log(`| Lane A composed | ${ok} sendable, ${blocked} blocked |`);
log(`| live sends, all time | **${sent.n}** |`);
log(`| guard at end | send=${gEnd.send} (${gEnd.reason}) |`);

mkdirSync("data", { recursive: true });
const file = `data/run-now-${new Date().toISOString().slice(0, 10)}.md`;
writeFileSync(file, out.join("\n"), "utf8");

await tg([
  `*Manual run complete*`,
  `${queued} approval cards above`,
  `Lane A: ${ok} composed, *held* \\(nothing sent\\)`,
  `Mode: ${esc(gEnd.reason)}`,
].join("\n"));

console.log(`\nwritten to ${file}`);
if (sent.n !== 0) {
  console.error(`\nWARNING: ${sent.n} live sends exist. Expected 0.`);
  process.exit(1);
}
