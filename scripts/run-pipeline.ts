/**
 * CLI runner for the harvest -> persist -> score path.
 *
 * Shares src/lib/sources.ts and src/lib/scoring.ts with the Trigger.dev tasks, so
 * what runs here is what runs in production. This replaces the earlier standalone
 * harvest.mjs / score.mjs, which had duplicated the same logic and would have
 * drifted the moment either side changed.
 *
 *   tsx scripts/run-pipeline.ts            harvest, persist to Neon, score
 *   tsx scripts/run-pipeline.ts --csv      also write data/listings-<date>.csv
 *   tsx scripts/run-pipeline.ts --no-db    skip Neon (offline check)
 */

import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { harvestAll } from "../src/lib/sources.js";
import { score } from "../src/lib/scoring.js";

const wantCsv = process.argv.includes("--csv");
const useDb = !process.argv.includes("--no-db");

const t0 = Date.now();
const { rows, competitors, report } = await harvestAll();

const live = report.filter((r) => r.status === "ok");
console.log(`\nsources: ${live.length}/${report.length} live   rows: ${rows.length}   competitors: ${competitors.length}`);
const dead = report.filter((r) => r.status !== "ok");
if (dead.length) console.log(`dead   : ${dead.map((d) => `${d.source}(${d.err})`).join(", ")}`);

// --- score in memory (same function the scheduled task calls)
const scored = rows.map((r) => {
  const { score: sc, why } = score({
    title: r.title, tier: r.tier,
    stack_tags: r.stack_tags, red_flags: r.red_flags,
    rate_min: r.rate_min, rate_type: r.rate_type,
    posted_at: r.posted_at || null,
    market_tier: r.market_tier, market_confidence: r.market_confidence,
  });
  return { ...r, fit_score: sc, score_why: why };
});
scored.sort((a, b) => (b.fit_score as number) - (a.fit_score as number));

const band = (lo: number, hi: number) =>
  scored.filter((r) => (r.fit_score as number) >= lo && (r.fit_score as number) < hi).length;
console.log(`\nscored: ${scored.length}`);
console.log(`  80-100 apply today : ${band(80, 101)}`);
console.log(`  65-79  strong      : ${band(65, 80)}`);
console.log(`  50-64  worth a look: ${band(50, 65)}`);
console.log(`  <50    skip        : ${band(0, 50)}`);
console.log(`  vetoed (score 0)   : ${scored.filter((r) => r.fit_score === 0).length}`);

// --- persist
if (useDb) {
  const { upsertListings } = await import("../src/lib/db.js");
  const { inserted, total } = await upsertListings(scored, { scoreToo: true });
  console.log(`
db: +${inserted} new, ${total} total rows in listings`);
}

// --- optional CSV
if (wantCsv) {
  const COLS = ["id", "source", "tier", "lane", "title", "company", "url", "rate_min",
    "rate_max", "rate_type", "posted_at", "stack_tags", "red_flags", "fit_score", "score_why"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  mkdirSync("data", { recursive: true });
  const out = `data/listings-${new Date().toISOString().slice(0, 10)}.csv`;
  writeFileSync(out,
    [COLS.join(","), ...scored.map((r) => COLS.map((c) => esc((r as any)[c])).join(","))].join("\n"),
    "utf8");
  console.log(`csv: ${out}`);
}

console.log(`\ntop 10:`);
for (const r of scored.slice(0, 10)) {
  console.log(`  ${String(r.fit_score).padStart(3)}  ${r.lane === "approve" ? "[APPROVE]" : "[auto]   "} ${r.source.padEnd(22).slice(0, 22)} ${r.title.slice(0, 58)}`);
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
