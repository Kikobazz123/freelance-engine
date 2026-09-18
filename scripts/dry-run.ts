/**
 * Full end-to-end dry run.
 *
 * Exercises the same library code the scheduled tasks call, in the same order,
 * and writes every generated artifact to data/dry-run-<date>.md for reading by
 * hand. Nothing is sent: the guard is asserted up front and the run aborts if it
 * reports otherwise.
 *
 * What this does NOT cover: the Trigger.dev scheduling wrapper itself. That needs
 * a deploy. This covers everything inside it.
 *
 *   tsx scripts/dry-run.ts
 */

import "dotenv/config";
import { writeFileSync, existsSync, statSync } from "node:fs";
import { sql, guard, getState, bidBudget, platformOf } from "../src/lib/db.js";
import { harvestAll } from "../src/lib/sources.js";
import { score } from "../src/lib/scoring.js";
import { writeProposal } from "../src/lib/proposal.js";
import { composeApplication, type Target } from "../src/lib/outreach.js";
import { validateClaims } from "../src/lib/claims.js";

const out: string[] = [];
const log = (s = "") => { console.log(s); out.push(s); };
const section = (s: string) => { log(""); log(`## ${s}`); log(""); };

/* ---- gate 0: refuse to run at all if anything could send ---------------- */
const g = await guard();
log(`# Dry run — ${new Date().toISOString()}`);
log("");
log(`guard: send=${g.send} — ${g.reason}`);
if (g.send) {
  console.error("\nABORT: guard reports sending is ENABLED. A dry run must not be able to send.");
  process.exit(1);
}
log("");
log("Sending is disabled. Nothing below leaves the machine.");

/* ---- 1. harvest --------------------------------------------------------- */
section("1. harvest");
const t0 = Date.now();
const { rows, competitors, report } = await harvestAll();
const live = report.filter((r) => r.status === "ok").length;
log(`sources: ${live}/${report.length} live · ${rows.length} listings · ${competitors.length} competitor posts · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const dead = report.filter((r) => r.status !== "ok");
if (dead.length) log(`dead: ${dead.map((d) => `${d.source}(${d.err})`).join(", ")}`);
log(`with a contact email: ${rows.filter((r) => r.contact_email).length}`);

/* ---- 2. score ----------------------------------------------------------- */
section("2. score");
const scored = rows.map((r) => ({
  ...r,
  ...score({
    title: r.title, tier: r.tier, stack_tags: r.stack_tags, red_flags: r.red_flags,
    rate_min: r.rate_min, rate_type: r.rate_type, posted_at: r.posted_at || null,
    market_tier: r.market_tier, market_confidence: r.market_confidence,
  }),
}));
const band = (lo: number, hi: number) => scored.filter((r) => r.score >= lo && r.score < hi).length;
log(`| band | count |`);
log(`|---|---|`);
log(`| 85-100 bid-eligible | ${band(85, 101)} |`);
log(`| 65-84 outreach | ${band(65, 85)} |`);
log(`| 50-64 marginal | ${band(50, 65)} |`);
log(`| <50 skip | ${band(0, 50)} |`);
log(`| vetoed (score 0) | ${scored.filter((r) => r.score === 0).length} |`);

/* ---- 3. generate: Lane B proposals -------------------------------------- */
section("3. generate — Lane B marketplace proposals (score >= 85)");
const laneB = (await sql`
  SELECT id, title, company, url, rate_min, rate_max, rate_type, stack_tags,
         source, fit_score, market, market_tier
  FROM listings
  WHERE lane='approve' AND fit_score >= 85 AND coalesce(market_tier,0) <> 3
  ORDER BY fit_score DESC LIMIT 3
`) as any[];

let bViolations = 0;
for (const l of laneB) {
  const p = await writeProposal(l);
  const v = validateClaims(p.body);
  if (v.length) bViolations++;
  log(`### ${l.title.slice(0, 70)}`);
  log(`\`${l.source}\` · fit ${l.fit_score} · ${l.market} · **$${p.rate}/hr** · ${p.provider}`);
  if (v.length) log(`> BLOCKED: ${v.map((x) => `${x.kind}: ${x.found}`).join("; ")}`);
  log("");
  log("```");
  log(p.body);
  log("```");
  log("");
}

/* ---- 4. dispatch: what the budget allows -------------------------------- */
section("4. dispatch — bid rationing");
for (const p of ["freelancer", "upwork"] as const) {
  const b = await bidBudget(p);
  log(`- **${p}**: ${b.left}/${b.allowance} ${b.unit}s left this month`);
}
const [counts] = (await sql`
  SELECT count(*) FILTER (WHERE lane='approve' AND fit_score>=85 AND coalesce(market_tier,0)<>3)::int AS bid_ready,
         count(*) FILTER (WHERE lane='auto' AND fit_score>=65 AND coalesce(market_tier,0)<>3
                            AND contact_email IS NOT NULL)::int AS lane_a_ready
  FROM listings`) as any[];
log(`- bid-ready listings: ${counts.bid_ready} (against 8 bids/month — rationing is doing work)`);
log(`- Lane A ready: ${counts.lane_a_ready}`);

/* ---- 5. Lane A emails --------------------------------------------------- */
section("5. send-lane-a — the emails that would actually go out");
const cvPath = "cv/Lordmark-Dorgu-AI-Automation-Engineer.pdf";
log(`CV attachment: ${existsSync(cvPath) ? `${(statSync(cvPath).size / 1024).toFixed(0)} KB` : "**MISSING**"}`);
log("");

const laneA = (await sql`
  SELECT title, company, url, source, contact_email, fit_score, stack_tags, market
  FROM listings l
  WHERE lane='auto' AND contact_email IS NOT NULL AND fit_score >= 65
    AND coalesce(market_tier,0) <> 3
    AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email = l.contact_email)
    AND NOT EXISTS (SELECT 1 FROM sends sn WHERE sn.to_address = l.contact_email AND sn.dry_run=false)
  ORDER BY fit_score DESC LIMIT 6
`) as any[];

let aSendable = 0, aBlocked = 0;
for (const r of laneA) {
  const c = await composeApplication(r as Target);
  const v = validateClaims(c.body);
  if (v.length) aBlocked++; else aSendable++;
  log(`### ${r.contact_email}`);
  log(`**${c.subject}**`);
  log(`\`${r.source}\` · fit ${r.fit_score} · ${r.market} · ${c.provider} · ${c.body.split(/\s+/).length} words`);
  if (v.length) log(`> BLOCKED: ${v.map((x) => `${x.kind}: ${x.found}`).join("; ")}`);
  log("");
  log("```");
  log(c.body);
  log("```");
  log("");
}

/* ---- 6. summary --------------------------------------------------------- */
section("6. summary");
log(`| check | result |`);
log(`|---|---|`);
log(`| guard | send=${g.send} (${g.reason}) |`);
log(`| sources live | ${live}/${report.length} |`);
log(`| listings harvested | ${rows.length} |`);
log(`| Lane B proposals generated | ${laneB.length}, ${bViolations} blocked |`);
log(`| Lane A emails generated | ${laneA.length}, ${aSendable} sendable, ${aBlocked} blocked |`);
log(`| CV attachment | ${existsSync(cvPath) ? "present" : "MISSING"} |`);
log(`| anything sent | **no** |`);

const file = `data/dry-run-${new Date().toISOString().slice(0, 10)}.md`;
writeFileSync(file, out.join("\n"), "utf8");
console.log(`\nwritten to ${file}`);
