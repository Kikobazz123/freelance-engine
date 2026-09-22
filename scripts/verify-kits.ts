/**
 * Assertions for apply kits and the send confirmation.
 *
 *   tsx scripts/verify-kits.ts
 */

// Never message the real chat from a test run (see TELEGRAM_DRY in telegram.ts).
process.env.TELEGRAM_DRY = "1";
// TEST_MODE: no real email, and batch sweeps touch only verify-* batches.
process.env.TEST_MODE = "1";

import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "../src/lib/db.js";
import { kitButtons, kitText, kitCandidates, markApplied, skipKit, retireIneligibleKits, type Kit } from "../src/lib/kits.js";
import { flagsFor } from "../src/lib/sources.js";
import { foreignLanguage } from "../src/lib/scoring.js";
import { formLetter } from "../src/lib/letter.js";
import { confirmationText } from "../src/lib/decisions.js";
import { IDENTITY } from "../src/config.js";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, x = "") => {
  c ? pass++ : fail++;
  console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? `  (${x})` : ""}`);
};

const L_FORM = "verify-kit-form";
const L_MAIL = "verify-kit-mail";

async function cleanup() {
  await sql`DELETE FROM apply_kits WHERE listing_id IN (${L_FORM}, ${L_MAIL})`;
  await sql`DELETE FROM sends WHERE lane = 'form' AND channel = 'verify-kits'`;
  await sql`DELETE FROM listings WHERE id IN (${L_FORM}, ${L_MAIL})`;
}

try {
  await cleanup();

  console.log("\n--- the card ---");
  const cb = kitButtons(123456).flat();
  ok(cb.length === 2 && cb.every((b) => Buffer.byteLength(b.callback_data) <= 64),
    "two buttons, callback data within Telegram's limit");
  const fake: Kit = {
    id: 7, listing_id: "x", body: "Dear Acme team,\n\nLetter.", status: "pending",
    title: "Backend Engineer", company: "Acme", url: "https://jobs.acme.io/1", source: "WWR-All",
    fit_score: 88, location: "Anywhere in the World", telegram_chat_id: null, telegram_message_id: null,
  };
  const t = kitText(fake);
  ok(t.includes("https://jobs.acme.io/1"), "the card carries the apply link");
  ok(t.includes("Dear Acme team,"), "the card carries the cover letter");
  ok(/I applied/.test(t), "the card tells him to confirm after submitting");

  console.log("\n--- the cover letter for a form ---");
  const fl = formLetter("Dear Acme team,", "I build typed automation pipelines.\n\nKind regards,\nSomeone");
  ok(fl.startsWith("Dear Acme team,"), "opens with the salutation");
  ok(!fl.includes(IDENTITY.phone) && !fl.includes(IDENTITY.email),
    "no phone or email block — the form has fields for those");
  ok(fl.includes(IDENTITY.name) && fl.includes("Kind regards,"), "signed with his name");
  ok((fl.match(/Kind regards,/g) ?? []).length === 1, "a model-written sign-off is stripped, not doubled");

  console.log("\n--- which jobs get a kit ---");
  for (const [id, email] of [[L_FORM, null], [L_MAIL, "jobs@verify-kits.invalid"]] as const) {
    await sql`
      INSERT INTO listings (id, source, tier, lane, title, url, fit_score, contact_email, red_flags, last_seen_at)
      VALUES (${id}, 'verify-kits', 'C', 'auto', ${`verify ${id}`}, 'https://example.invalid/apply',
              99, ${email}, ARRAY[]::text[], now())
    `;
  }
  const cands = (await kitCandidates(2000)).map((r: any) => r.id);
  ok(cands.includes(L_FORM), "a form-only job gets a kit");
  ok(!cands.includes(L_MAIL), "a job with an email goes to the email lane, never a kit");

  console.log("\n--- confirming an application ---");
  const [k] = (await sql`
    INSERT INTO apply_kits (listing_id, body) VALUES (${L_FORM}, 'letter') RETURNING id
  `) as { id: number }[];
  const first = await markApplied("fake-callback-id", Number(k.id));
  ok(first === "applied", "I applied records the application", first);
  const second = await markApplied("fake-callback-id", Number(k.id));
  ok(second === "already_applied", "a second tap records nothing more", second);
  const [s] = (await sql`
    SELECT count(*)::int AS n FROM sends WHERE lane = 'form' AND channel = 'verify-kits'
  `) as { n: number }[];
  ok(s.n === 1, "exactly one application row, however many taps", String(s.n));
  const sk = await skipKit("fake-callback-id", Number(k.id));
  ok(sk === "already_applied", "an applied kit cannot be skipped afterwards", sk);
  ok((await kitCandidates(2000)).every((r: any) => r.id !== L_FORM), "a kitted job is never kitted twice");

  console.log("\n--- the two real kits that should not have been posted ---");
  const usb = "U.S.-Based Software Developer – Remote";
  ok(flagsFor(usb, "Reddit-forhire", usb).split("|").includes("us_only"), "'U.S.-Based' is US-only");
  ok(foreignLanguage("Pessoa Engenheira de Dados Sênior"), "a Portuguese title is vetoed");
  ok(foreignLanguage("Desarrollador Python Senior"), "a Spanish title is vetoed");
  ok(!foreignLanguage("Senior Backend Engineer (m/w/d)"), "an English title with (m/w/d) is kept");
  ok(!foreignLanguage("Data Engineer — Portuguese speaker a plus"), "mentioning a language is not a veto");

  // A kit whose job stops qualifying is withdrawn, not left as work to do.
  await sql`UPDATE listings SET fit_score = 0, score_why = 'VETO:us_only' WHERE id = ${L_MAIL}`;
  const [k2] = (await sql`
    INSERT INTO apply_kits (listing_id, body) VALUES (${L_MAIL}, 'letter') RETURNING id
  `) as { id: number }[];
  const withdrawn = await retireIneligibleKits();
  const [st] = (await sql`SELECT status, blocked_reason FROM apply_kits WHERE id = ${k2.id}`) as any[];
  ok(withdrawn >= 1 && st.status === "skipped", "a kit for a now-vetoed job is withdrawn", `${st.status}: ${st.blocked_reason}`);

  console.log("\n--- the email confirmation ---");
  const conf = confirmationText("20260922-abcd", [
    { to: "jobs@a.io", title: "AI Engineer", company: "A", url: "https://a.io/j" },
    { to: "hr@b.io", title: "Backend Dev", company: null, url: "https://b.io/j" },
  ], true);
  ok(/CONFIRMED — 2 applications sent/.test(conf) && /auto-released/.test(conf), "states the count and how it was released");
  ok(conf.includes("jobs@a.io") && conf.includes("hr@b.io"), "names every recipient");

  console.log("\n--- no code path submits a form ---");
  const src = readFileSync("src/lib/kits.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  ok(!/\bfetch\s*\(/.test(src), "kits.ts makes no HTTP requests of its own");

  await cleanup();
  const [left] = (await sql`
    SELECT count(*)::int AS n FROM listings WHERE id IN (${L_FORM}, ${L_MAIL})
  `) as { n: number }[];
  ok(left.n === 0, "test data cleaned up");
} catch (e) {
  console.error(`\nSUITE CRASHED: ${(e as Error).message}`);
  fail++;
} finally {
  await cleanup().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
