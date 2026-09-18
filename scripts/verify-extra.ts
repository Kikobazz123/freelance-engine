/**
 * Geo-targeting and bid-rationing assertions.
 *
 * Kept in its own file rather than appended to verify.ts: these depend on the
 * scoring and geo modules, and separating them keeps the safety-critical
 * send-guard checks in verify.ts readable on their own.
 *
 *   tsx scripts/verify-extra.ts
 */

import "dotenv/config";
import { bidBudget, platformOf, FREE_ALLOWANCE } from "../src/lib/db.js";
import { marketOf } from "../src/lib/geo.js";
import { score } from "../src/lib/scoring.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  ok ? pass++ : fail++;
};

console.log("\n--- geo targeting ---");

// The expensive error is a wrong veto, so an unstated location must never be one.
const unknownHit = marketOf("Build me an AI agent", "SomeFeed", "https://example.com/1");
check("unstated location resolves to unknown, not a veto",
  unknownHit.tier === 0, unknownHit.signal);

// Conflicting evidence: "India" inside a US/Canada remote post must not veto.
// This was a real false positive found auditing 982 live listings.
const amb = marketOf(
  "Oscilar | Sr Engineers | REMOTE (US/Canada) | also hiring in India", "X", "https://x.com");
check("conflicting Tier1+Tier3 signals resolve to unknown", amb.tier === 0, amb.signal);

// A genuine low-rate posting must veto.
const t3 = marketOf("Wordpress dev needed, budget 15000 INR, Mumbai team", "X", "https://x.in/j");
check("positively identified low-rate market is Tier 3",
  t3.tier === 3, `${t3.market} via ${t3.signal}`);

// Case sensitivity: /US/i would match "contact us" and tag the corpus American.
const notUs = marketOf("Please contact us about this role", "X", "https://x.com");
check('"contact us" is not read as the United States', notUs.market !== "US", notUs.signal);

// A real currency symbol IS evidence.
const uk = marketOf("Automation engineer, £500/day, London", "X", "https://x.com");
check("currency + city detected as Tier 1", uk.tier === 1 && uk.confidence === "high",
  `${uk.market} via ${uk.signal}`);

// Feed-level priors must be low confidence so a guess cannot outrank a fact.
const prior = marketOf("Backend engineer", "WWR-All", "https://weworkremotely.com/x");
check("feed-level inference is marked low confidence",
  prior.confidence === "low", prior.signal);

const base = {
  title: "Senior AI automation engineer", tier: "A",
  stack_tags: "automation|agents|python|typescript", red_flags: "",
  rate_min: 90, rate_type: "hourly", posted_at: new Date().toISOString(),
};

const vetoScore = score({ ...base, market_tier: 3, market_confidence: "high" });
check("Tier 3 market vetoes an otherwise perfect listing",
  vetoScore.score === 0, `score=${vetoScore.score}`);

// Unknown must not be penalised — 42% of real listings state no location, and
// penalising them would gut the funnel.
const unknownScore = score({ ...base, market_tier: 0, market_confidence: "low" });
check("unknown market still scores well", unknownScore.score >= 85, `score=${unknownScore.score}`);

const highT1 = score({ ...base, market_tier: 1, market_confidence: "high" });
const lowT1 = score({ ...base, market_tier: 1, market_confidence: "low" });
check("evidence outranks assumption for the same tier",
  highT1.score >= lowT1.score, `high=${highT1.score} low=${lowT1.score}`);

console.log("\n--- bid rationing ---");

check("Freelancer free allowance is 6 bids", FREE_ALLOWANCE.freelancer.n === 6);
check("Upwork free allowance is 10 connects", FREE_ALLOWANCE.upwork.n === 10);
check("Freelancer sources map to the freelancer budget",
  platformOf("Freelancer-ai-agent") === "freelancer");
check("free-to-apply sources consume no budget", platformOf("WWR-All") === null);

const fb = await bidBudget("freelancer");
check("budget row exists and never reports negative remaining",
  fb.left >= 0 && fb.left <= fb.allowance, `${fb.left}/${fb.allowance} ${fb.unit}s`);

const ub = await bidBudget("upwork");
check("upwork budget tracked in connects", ub.unit === "connect", `${ub.left}/${ub.allowance}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
