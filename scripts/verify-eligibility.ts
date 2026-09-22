/**
 * Eligibility against real location strings, copied verbatim from the feeds on
 * 2026-09-22. Each one is a case the engine used to ignore.
 *
 *   tsx scripts/verify-eligibility.ts
 */

// Never message the real chat from a test run (see TELEGRAM_DRY in telegram.ts).
process.env.TELEGRAM_DRY = "1";

import { eligibility, type Eligibility } from "../src/lib/eligibility.js";
import { score } from "../src/lib/scoring.js";

let pass = 0, fail = 0;
const expect = (input: string | string[], want: Eligibility, where: string) => {
  const got = eligibility(input);
  const label = `${where.padEnd(14)} ${JSON.stringify(input).slice(0, 70)} -> ${want}`;
  if (got === want) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  (got ${got})`); }
};

console.log("\n--- open to someone in Nigeria ---");
expect("Anywhere in the World", "open", "WWR");
expect("Worldwide", "open", "Remotive");
expect("Anywhere", "open", "Jobicy");
expect("APAC,  EMEA", "open", "Jobicy");
expect("Global", "open", "WorkingNomads");
expect("Internationally located (not in the US, CA, UK, NZ, or AU)", "open", "WorkingNomads");
expect("Remote (Worldwide) - Working East Coast Hours", "open", "WorkingNomads");
expect("Time zone: CET (+/- 3 hours)", "open", "WorkingNomads");
expect(["Nigeria", "Kenya"], "open", "Himalayas");
expect("UTC+1", "open", "synthetic");

console.log("\n--- US-only (vetoed) ---");
expect("USA Only", "us_only", "WWR");
expect("North America Only", "us_only", "WWR");
expect("USA, Canada, USA timezones", "us_only", "Remotive");
expect("United States", "us_only", "WorkingNomads");
expect("Remote - USA", "us_only", "RemoteJobs.org");
expect(["Canada", "United States"], "us_only", "Himalayas");
expect("New York, New York, New York, United States", "us_only", "RemoteOK");

console.log("\n--- locked to somewhere else (vetoed) ---");
expect("Anywhere in India", "region_locked", "WorkingNomads");
expect("LATAM", "region_locked", "RemoteJobs.org");
expect("Australia & New Zealand (REMOTE)", "region_locked", "WorkingNomads");
expect("Philippines, Nicaragua, South Africa, Guatemala", "region_locked", "WorkingNomads");
expect(["Mexico"], "region_locked", "Himalayas");
expect("USA, Canada, Argentina, Mexico, Peru", "us_only", "Remotive");

console.log("\n--- Europe/UK (graded penalty, not a veto) ---");
expect("Europe", "eu_only", "Remotive");
expect("Europe,  UK", "eu_only", "Jobicy");
expect("United Kingdom", "eu_only", "WorkingNomads");
expect(["Germany"], "eu_only", "Himalayas");
expect("Americas, Europe, Israel", "eu_only", "Remotive");

console.log("\n--- silence is not evidence ---");
expect("", "unknown", "RemoteOK");
expect("Chennai, ", "unknown", "RemoteOK");
expect("Remote", "unknown", "RemoteJobs.org");

console.log("\n--- the verdicts reach the score ---");
const base = {
  title: "Backend Engineer (Python)", tier: "C", stack_tags: "python|api|automation",
  rate_min: "" as const, rate_type: null, posted_at: new Date().toISOString(),
  market_tier: 1 as const, market_confidence: "high" as const,
};
const locked = score({ ...base, red_flags: "region_locked" });
const eu = score({ ...base, red_flags: "eu_only" });
const open = score({ ...base, red_flags: "" });
const ok = (c: boolean, n: string, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? `  (${x})` : ""}`); };
ok(locked.score === 0 && locked.why === "VETO:region_locked", "a region-locked job scores 0", `${locked.score} ${locked.why}`);
ok(eu.score > 0 && eu.score < open.score, "a Europe-only job is penalised, not vetoed", `${eu.score} vs ${open.score}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
