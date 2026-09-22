/**
 * The ranking: the title decides what a job is, ties above 100 are broken, and
 * things that are not jobs never rank. Fixtures are real titles from the feeds.
 *
 *   tsx scripts/verify-ranking.ts
 */

// Never message the real chat from a test run (see TELEGRAM_DRY in telegram.ts).
process.env.TELEGRAM_DRY = "1";
// TEST_MODE: no real email, and batch sweeps touch only verify-* batches.
process.env.TEST_MODE = "1";

import { score, titleFit, notTechnical, type Scorable } from "../src/lib/scoring.js";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, x = "") => {
  c ? pass++ : fail++;
  console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? `  (${x})` : ""}`);
};

/** Everything equal except the title — so only the title can separate them. */
const same = (title: string, extra: Partial<Scorable> = {}) => score({
  title, tier: "C", stack_tags: "typescript|python|agents|automation|claude",
  red_flags: "", rate_min: "", rate_type: null, posted_at: new Date().toISOString(),
  market_tier: 1, market_confidence: "high", source: "WWR-All", ...extra,
});

console.log("\n--- the old ties at 100 now separate, on the title alone ---");
const agent = same("Sticker Mule: AI agent engineer");
const automation = same("AI and Automation Specialist");
const advocate = same("Datadog: Developer Advocate - Service Management EMEA");
const consultant = same("Data & Insights Technical Consultant (CJA) (100% Remote)");
const teacher = same("Automation & AI Adoption Teaching Expert");
const qa = same("Proxify AB: Senior QA Automation Engineer");
ok(agent.raw > advocate.raw + 20, "AI agent engineer ranks well above Developer Advocate", `${agent.raw} vs ${advocate.raw}`);
ok(automation.raw > consultant.raw + 20, "Automation Specialist ranks well above a CJA consultant", `${automation.raw} vs ${consultant.raw}`);
ok(agent.raw > teacher.raw + 20, "an engineering role beats a teaching role", `${agent.raw} vs ${teacher.raw}`);
ok(agent.raw > qa.raw, "AI agent engineer beats QA automation", `${agent.raw} vs ${qa.raw}`);
// Both clear 100; a real difference between them (one is explicitly open to
// him) must still show in the ordering rather than vanish under the clamp.
const agentOpen = same("Sticker Mule: AI agent engineer", { eligibility: "open" });
ok(agent.score === 100 && agentOpen.score === 100 && agentOpen.raw > agent.raw,
  "a difference above 100 still orders two jobs that both score 100", `${agentOpen.raw} > ${agent.raw}`);

console.log("\n--- title fit ---");
ok(titleFit("Sticker Mule: AI agent engineer").points >= 18, "core role recognised");
ok(titleFit("Full Stack TypeScript Developer").points >= 10, "his stack in the title recognised");
ok(titleFit("Developer Advocate").points < 0, "an adjacent role nets negative");
ok(titleFit("Backend Engineer (Python/TypeScript)").why.some((w) => w.startsWith("title-stack")),
  "technologies named in the title count");

console.log("\n--- the signals that match what he actually wants ---");
const contract = same("Backend Engineer", { rate_type: "hourly", rate_min: 45 });
const salaried = same("Backend Engineer");
ok(contract.why.includes("contract+8"), "contract / hourly work is preferred", contract.why);
const open = same("Backend Engineer", { eligibility: "open" });
ok(open.raw === salaried.raw + 8, "a job explicitly open to him outranks silence", `${open.raw} vs ${salaried.raw}`);
ok(same("Senior Backend Engineer").raw < salaried.raw, "Senior ranks below the same role without it");
ok(same("Lead Backend Engineer").raw < same("Senior Backend Engineer").raw, "Lead ranks below Senior");

console.log("\n--- things that are not engineering jobs never rank ---");
const therapist = same("BetterHelp: Licensed Clinical Marriage and Family Therapist");
ok(therapist.score === 0 && therapist.why === "VETO:not-technical",
  "a therapist role is vetoed (it ranked 88)", `${therapist.score} ${therapist.why}`);
for (const t of ["Grid Operator", "Chaplain (Part-Time)", "Voice Actor - UK English Expert", "Coinbase: Accounting Manager"]) {
  ok(notTechnical(t, "WWR-All"), `vetoed on a job board: ${t}`);
}
for (const t of ["AI and Automation Specialist", "Frontend Developer", "Data Platform Lead", "Web Scraping Specialist"]) {
  ok(!notTechnical(t, "Himalayas-NG-python"), `kept: ${t}`);
}
ok(!notTechnical("Automate Harvest invoice creation", "Freelancer-automation"),
  "a marketplace brief is not held to job-title rules");
ok(!notTechnical("We're building a unified platform for credit data", "HN-WhoIsHiring"),
  "an HN post's opening line is not held to job-title rules");
ok(same("anything", { red_flags: "not_a_posting" }).why === "VETO:not_a_posting",
  "an HN reply (not a posting) is vetoed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
