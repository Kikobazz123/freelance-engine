/**
 * Lane A assertions — the only path in this system that can reach a real
 * stranger, so these are the assertions that matter most.
 *
 * Self-cleaning: uses throwaway listings and removes them, including any
 * suppression rows it creates.
 *
 *   tsx scripts/verify-lane-a.ts
 */

// Never message the real chat from a test run (see TELEGRAM_DRY in telegram.ts).
process.env.TELEGRAM_DRY = "1";

import "dotenv/config";
import { sql, guard, getState, setState } from "../src/lib/db.js";
import { gmailSend } from "../src/lib/gmail.js";
import { extractContact } from "../src/lib/contact.js";
import { subjectFor, footerFor, isStub, SENDER_NAME, SENDER_LOCATION } from "../src/lib/outreach.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  ok ? pass++ : fail++;
};

const TEST_ADDR = "zzz-test-lane-a@example-not-real.invalid";
const LID = "zzz_test_lanea";

async function cleanup() {
  await sql`DELETE FROM listings WHERE id LIKE 'zzz_test_lanea%'`;
  await sql`DELETE FROM sends WHERE to_address = ${TEST_ADDR}`;
  await sql`DELETE FROM suppression WHERE email = ${TEST_ADDR}`;
}
await cleanup();

console.log("\n--- gate 6: gmailSend cannot touch the network in dry run ---");
{
  const r = await gmailSend({
    to: "nobody@example.invalid", subject: "x", body: "x", dryRun: true,
    attachment: { filename: "x.pdf", contentType: "application/pdf", data: Buffer.from("x") },
  });
  check("dryRun returns null even with an attachment", r === null);
}

console.log("\n--- gate 5: a stub is never a sendable body ---");
{
  check("stub body detected", isStub("[STUB — no LLM provider available]"));
  check("real body not flagged as stub", !isStub("I build automation pipelines."));
}

console.log("\n--- CAN-SPAM: identity, location, opt-out ---");
{
  const f = footerFor();
  check("footer carries the real name", f.includes(SENDER_NAME));
  check("footer carries a physical location", f.includes(SENDER_LOCATION));
  check("footer carries a working opt-out", /no thanks/i.test(f));
  const s = subjectFor({
    title: "Squoosh.AI | Full-Stack Engineer (REMOTE) | apply",
    company: null, url: "", source: "HN", contact_email: "", fit_score: 90, stack_tags: [],
  });
  check("subject is specific and names the sender",
    s.includes(SENDER_NAME) && s.length < 110, s);
}

console.log("\n--- gate 2/3: suppression and one-per-address ---");
{
  // A real (non-dry) send row for the test address.
  await sql`
    INSERT INTO listings (id, source, tier, lane, title, url, fit_score, market_tier, contact_email)
    VALUES (${LID}, 'HN-WhoIsHiring', 'F', 'auto', 'TEST lane A', 'https://example.com/x',
            95, 1, ${TEST_ADDR})
  `;
  await sql`
    INSERT INTO sends (lane, channel, to_address, dry_run)
    VALUES ('auto', 'HN-WhoIsHiring', ${TEST_ADDR}, false)
  `;

  // The unique index must reject a second live send to the same address.
  let blocked = false;
  try {
    await sql`
      INSERT INTO sends (lane, channel, to_address, dry_run)
      VALUES ('auto', 'HN-WhoIsHiring', ${TEST_ADDR}, false)
    `;
  } catch (e) {
    blocked = /duplicate key|sends_addr_once/i.test(String((e as Error).message));
  }
  check("database rejects a second live send to the same address", blocked);

  // The candidate query must exclude an already-written address.
  const [c1] = (await sql`
    SELECT count(*)::int AS n FROM listings l
    WHERE l.id = ${LID}
      AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.to_address = l.contact_email AND s.dry_run = false)
  `) as any[];
  check("candidate query excludes an already-contacted address", c1.n === 0);

  // Suppression must also exclude, independently.
  await sql`DELETE FROM sends WHERE to_address = ${TEST_ADDR}`;
  await sql`INSERT INTO suppression (email, reason) VALUES (${TEST_ADDR}, 'test')`;
  const [c2] = (await sql`
    SELECT count(*)::int AS n FROM listings l
    WHERE l.id = ${LID}
      AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email = l.contact_email)
  `) as any[];
  check("candidate query excludes a suppressed address", c2.n === 0);
}

console.log("\n--- gate 4: daily cap ---");
{
  const before = await getState<number>("daily_cap_auto", 25);
  await setState("daily_cap_auto", 0);
  const cap = await getState<number>("daily_cap_auto", 25);
  check("cap of 0 leaves no remaining budget", Math.max(0, cap - 0) === 0);
  await setState("daily_cap_auto", before);
  check("cap restored", (await getState<number>("daily_cap_auto", 0)) === before, `${before}`);
}

console.log("\n--- gate 1: the guard mechanism ---");
{
  // Test the MECHANISM, not the ambient state. Asserting "we are in dry run"
  // began failing the moment the pipeline went live - the test being wrong, not
  // the system. What must always hold: either brake alone blocks, and both must
  // be off deliberately before anything sends.
  const b4 = { enabled: await getState<boolean>("enabled", true),
               dry: await getState<boolean>("dry_run", true) };
  const envB4 = process.env.DRY_RUN;
  try {
    await setState("enabled", true); await setState("dry_run", true);
    process.env.DRY_RUN = "false";
    check("db brake alone blocks sending", !(await guard()).send);
    await setState("dry_run", false); process.env.DRY_RUN = "true";
    check("env brake alone blocks sending", !(await guard()).send);
    await setState("enabled", false); process.env.DRY_RUN = "false";
    check("kill switch overrides both", !(await guard()).send);
    await setState("enabled", true); await setState("dry_run", false);
    process.env.DRY_RUN = "false";
    check("sends only when both brakes are deliberately off", (await guard()).send);
  } finally {
    await setState("enabled", b4.enabled); await setState("dry_run", b4.dry);
    if (envB4 === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = envB4;
  }
}

console.log("\n--- contact extraction refuses the wrong addresses ---");
{
  check("job-seeker gmail rejected",
    extractContact("I am looking for work, email me at jobseeker.fixture.test@gmail.com") === null);
  check("noreply rejected",
    extractContact("Questions? contact noreply@acme.com") === null);
  check("company hiring address accepted",
    extractContact("Acme | Engineer | email jobs@acme.io")?.email === "jobs@acme.io");
}

await cleanup();
const [left] = (await sql`
  SELECT (SELECT count(*) FROM listings WHERE id LIKE 'zzz_test_lanea%')::int
       + (SELECT count(*) FROM suppression WHERE email = ${TEST_ADDR})::int AS n
`) as any[];
check("test data cleaned up", left.n === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
