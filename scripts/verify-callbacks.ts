/**
 * Callback-handler assertions, run against the real database with a throwaway
 * listing and proposal. Self-cleaning.
 *
 * The thing being proved: a double-press cannot spend two bids. Telegram
 * redelivers an update until the offset is acknowledged, and the task retries up
 * to 3 times, so duplicates are certain — and the monthly budget is six.
 *
 *   tsx scripts/verify-callbacks.ts
 */

import "dotenv/config";
import { sql, bidBudget, platformOf, FREE_ALLOWANCE } from "../src/lib/db.js";
import { approve, skip, fullText } from "../src/lib/decisions.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  ok ? pass++ : fail++;
};

const LID = "zzz_test_cb";

/**
 * Snapshot the real spend before touching anything and put it back at the end.
 * The first run of this file spent a genuine Freelancer bid and left it spent —
 * one of six for the month. A test that consumes production budget is a bug.
 */
const SPEND_BEFORE = {
  freelancer: (await bidBudget("freelancer")).spent,
  upwork: (await bidBudget("upwork")).spent,
};
async function restoreBudgets() {
  for (const [p, spent] of Object.entries(SPEND_BEFORE)) {
    await sql`
      UPDATE bid_budget SET spent = ${spent}
      WHERE platform = ${p} AND period = date_trunc('month', now())::date
    `;
  }
}

async function reset(source: string): Promise<number> {
  await sql`DELETE FROM listings WHERE id = ${LID}`; // cascades to proposals/sends
  await sql`
    INSERT INTO listings (id, source, tier, lane, title, url, fit_score, market_tier)
    VALUES (${LID}, ${source}, 'A', 'approve', 'TEST callback listing',
            'https://example.com/test', 95, 1)
  `;
  const [p] = (await sql`
    INSERT INTO proposals (listing_id, body, rate_quoted, status)
    VALUES (${LID}, 'test proposal body', 45, 'pending_approval')
    RETURNING id
  `) as { id: number }[];
  return p.id;
}

// Telegram calls are stubbed out by giving a callback id that the API will
// reject; decisions.ts treats a failed answerCallback as fatal, so instead we
// point at a chat/message that does not exist and let markCard swallow it.
// The DB effects are what matter here.
const CB = "test-callback-id";

/* 1. a clean approve spends exactly one bid */
{
  const before = (await bidBudget("freelancer")).spent;
  const id = await reset("Freelancer-ai-agent");
  let r = "";
  try { r = await approve(CB, id); } catch { r = "telegram_error"; }

  const [p] = (await sql`SELECT status, bid_cost, bid_platform FROM proposals WHERE id = ${id}`) as any[];
  const after = (await bidBudget("freelancer")).spent;

  check("approve sets status=approved", p?.status === "approved", `status=${p?.status}`);
  check("approve records the platform and cost",
    p?.bid_platform === "freelancer" && p?.bid_cost === 1, `${p?.bid_platform}/${p?.bid_cost}`);
  check("approve spends exactly 1 bid", after === before + 1, `${before} -> ${after}`);

  /* 2. pressing Approve again spends NOTHING */
  const beforeDup = (await bidBudget("freelancer")).spent;
  let dup = "";
  try { dup = await approve(CB, id); } catch { dup = "telegram_error"; }
  const afterDup = (await bidBudget("freelancer")).spent;
  check("duplicate approve does not spend a second bid",
    afterDup === beforeDup, `${beforeDup} -> ${afterDup}`);

  /* 3. a send row exists, and only one */
  const [s] = (await sql`SELECT count(*)::int AS n FROM sends WHERE proposal_id = ${id}`) as any[];
  check("exactly one send row recorded", s.n === 1, `rows=${s.n}`);

  /* 4. skip after approve must not reopen it */
  try { await skip(CB, id); } catch { /* telegram */ }
  const [p2] = (await sql`SELECT status FROM proposals WHERE id = ${id}`) as any[];
  check("skip cannot override an approval", p2?.status === "approved", `status=${p2?.status}`);
}

/* 5. skip on a fresh proposal */
{
  const id = await reset("Freelancer-python");
  const before = (await bidBudget("freelancer")).spent;
  try { await skip(CB, id); } catch { /* telegram */ }
  const [p] = (await sql`SELECT status FROM proposals WHERE id = ${id}`) as any[];
  const after = (await bidBudget("freelancer")).spent;
  check("skip sets status=skipped", p?.status === "skipped", `status=${p?.status}`);
  check("skip spends no budget", after === before, `${before} -> ${after}`);

  /* 6. approve after skip must not fire */
  try { await approve(CB, id); } catch { /* telegram */ }
  const [p2] = (await sql`SELECT status FROM proposals WHERE id = ${id}`) as any[];
  check("approve cannot override a skip", p2?.status === "skipped", `status=${p2?.status}`);
}

/* 7. full text leaves the card actionable */
{
  const id = await reset("Freelancer-chatbot");
  try { await fullText(CB, id); } catch { /* telegram */ }
  const [p] = (await sql`SELECT status FROM proposals WHERE id = ${id}`) as any[];
  check("full-text request does not decide the proposal",
    p?.status === "pending_approval", `status=${p?.status}`);
}

/* 8. budget exhaustion refuses rather than going negative */
{
  const id = await reset("Freelancer-automation");
  const b = await bidBudget("freelancer");
  await sql`
    UPDATE bid_budget SET spent = allowance
    WHERE platform = 'freelancer' AND period = date_trunc('month', now())::date
  `;
  let r = "";
  try { r = await approve(CB, id); } catch { r = "telegram_error"; }
  const [p] = (await sql`SELECT status FROM proposals WHERE id = ${id}`) as any[];
  const after = await bidBudget("freelancer");
  check("approve refused when budget is exhausted",
    p?.status === "pending_approval", `status=${p?.status}`);
  check("budget never goes negative", after.left >= 0, `left=${after.left}`);
  // restore the real spend count
  await sql`
    UPDATE bid_budget SET spent = ${b.spent}
    WHERE platform = 'freelancer' AND period = date_trunc('month', now())::date
  `;
}

/* 9. platform mapping */
check("Upwork source maps to the upwork budget", platformOf("Upwork-ai") === "upwork");
check("a free board consumes no platform budget", platformOf("WWR-All") === null);
check("upwork allowance is counted in connects", FREE_ALLOWANCE.upwork.unit === "connect");

await sql`DELETE FROM listings WHERE id = ${LID}`;
const [left] = (await sql`SELECT count(*)::int AS n FROM listings WHERE id = ${LID}`) as any[];
check("test data cleaned up", left.n === 0);

await restoreBudgets();
const fb = await bidBudget("freelancer");
const ub = await bidBudget("upwork");
check("freelancer budget restored to its pre-test value",
  fb.spent === SPEND_BEFORE.freelancer, `spent=${fb.spent}`);
check("upwork budget restored to its pre-test value",
  ub.spent === SPEND_BEFORE.upwork, `spent=${ub.spent}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
