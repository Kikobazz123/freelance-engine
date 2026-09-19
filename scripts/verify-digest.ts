/**
 * Assertions for the batch digest and the one-tap approve path.
 *
 * The risky properties here are not "does it send" but "can it send twice", "can
 * it send while held", and "does the card ever lie about what happened". Those
 * are what this checks.
 *
 * Uses a synthetic batch with zero sendable drafts, so the live approve path can
 * be exercised end to end without any email leaving the machine.
 *
 *   tsx scripts/verify-digest.ts
 */

import "dotenv/config";
import { sql, getState, setState } from "../src/lib/db.js";
import { approveAll, skipAll } from "../src/lib/decisions.js";
import { sendBatch } from "../src/lib/drafts.js";
import { controlButtons, approvedButton, controlText } from "../src/lib/digest.js";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`  PASS  ${name}${extra ? `  (${extra})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? `  (${extra})` : ""}`); }
};

const TEST_BATCH = "verify-digest-batch";
const TEST_LISTING = "verify-digest-listing";

/** Captured so a crash cannot leave the real pipeline in a test state. */
const savedDry = await getState<boolean>("dry_run", true);

async function cleanup() {
  await sql`DELETE FROM outreach_drafts WHERE batch_id = ${TEST_BATCH}`;
  await sql`DELETE FROM digests WHERE batch_id = ${TEST_BATCH}`;
  await sql`DELETE FROM listings WHERE id = ${TEST_LISTING}`;
  await setState("dry_run", savedDry);
}

try {
  /* ------------------------------------------------- pure formatting checks */
  console.log("\n--- the card cannot outgrow what Telegram accepts ---");

  const bigBatch = "20260918-abcd";
  const cbData = controlButtons(bigBatch, 99)[0].map((b) => b.callback_data);
  ok(
    cbData.every((d) => Buffer.byteLength(d, "utf8") <= 64),
    "callback_data fits Telegram's 64-byte limit",
    cbData.join(" / "),
  );
  ok(
    approvedButton(bigBatch).length === 1 && approvedButton(bigBatch)[0].length === 1,
    "a decided card is left with exactly one button",
  );
  ok(
    approvedButton(bigBatch)[0][0].text.includes("Approved"),
    "that button reads as approved",
    approvedButton(bigBatch)[0][0].text,
  );
  ok(
    controlText(bigBatch, 12, 3).includes("12 drafts ready to send"),
    "the card states exactly how many one tap will send",
  );
  ok(
    /never|human click/i.test(controlText(bigBatch, 12, 3)),
    "the card says marketplace proposals are not included",
  );

  /* -------------------------------------------------- the send-side brakes */
  console.log("\n--- sendBatch refuses to run while held ---");

  await setState("dry_run", true);
  let threw = "";
  try { await sendBatch(TEST_BATCH); } catch (e) { threw = String((e as Error).message); }
  ok(threw.includes("refusing to send"), "db brake stops a batch send", threw.slice(0, 60));

  await setState("dry_run", savedDry);

  /* --------------------------------------------- the one-tap approve path */
  console.log("\n--- one-tap approve is idempotent ---");

  await cleanupRows();
  await sql`
    INSERT INTO listings (id, source, tier, lane, title, url, fit_score)
    VALUES (${TEST_LISTING}, 'verify', 'A', 'auto', 'verify digest listing',
            'https://example.invalid/verify', 90)
    ON CONFLICT (id) DO NOTHING
  `;
  // n_drafts 0 and no draft rows: the live path runs end to end and sends nothing.
  await sql`
    INSERT INTO digests (batch_id, n_drafts, status) VALUES (${TEST_BATCH}, 0, 'pending')
  `;

  const live = await getState<boolean>("dry_run", true);
  if (live !== false) {
    console.log("  SKIP  approve path (pipeline is in dry run; nothing to assert safely)");
  } else {
    const first = await approveAll("fake-callback-id", TEST_BATCH);
    ok(first.startsWith("sent_"), "first press runs the batch", first);

    const after = (await sql`
      SELECT status FROM digests WHERE batch_id = ${TEST_BATCH}
    `) as { status: string }[];
    ok(after[0]?.status === "sent", "batch is marked decided", after[0]?.status);

    const second = await approveAll("fake-callback-id", TEST_BATCH);
    ok(second === "already_sent", "a second press does nothing", second);
  }

  /* ------------------------------------------------------------- skip path */
  console.log("\n--- skip all discards without sending ---");

  await sql`DELETE FROM digests WHERE batch_id = ${TEST_BATCH}`;
  await sql`DELETE FROM outreach_drafts WHERE batch_id = ${TEST_BATCH}`;
  await sql`
    INSERT INTO digests (batch_id, n_drafts, status) VALUES (${TEST_BATCH}, 1, 'pending')
  `;
  await sql`
    INSERT INTO outreach_drafts
      (batch_id, listing_id, to_address, subject, salutation, body, status)
    VALUES (${TEST_BATCH}, ${TEST_LISTING}, 'verify-digest@example.invalid',
            's', 'Dear team,', 'b', 'draft')
  `;

  const sk = await skipAll("fake-callback-id", TEST_BATCH);
  ok(sk === "skipped_1", "skip all marks the drafts skipped", sk);

  const left = (await sql`
    SELECT count(*)::int AS n FROM outreach_drafts
    WHERE batch_id = ${TEST_BATCH} AND status = 'draft'
  `) as { n: number }[];
  ok(left[0].n === 0, "no draft is left sendable after a skip");

  const sent = (await sql`
    SELECT count(*)::int AS n FROM sends WHERE to_address = 'verify-digest@example.invalid'
  `) as { n: number }[];
  ok(sent[0].n === 0, "skipping sent nothing");

  const sk2 = await skipAll("fake-callback-id", TEST_BATCH);
  ok(sk2 === "race_lost", "a second skip does nothing", sk2);

  /* -------------------------------------------------------------- cleanup */
  console.log("\n--- cleanup ---");
  await cleanup();
  const gone = (await sql`
    SELECT count(*)::int AS n FROM digests WHERE batch_id = ${TEST_BATCH}
  `) as { n: number }[];
  ok(gone[0].n === 0, "test data cleaned up");

  const restored = await getState<boolean>("dry_run", true);
  ok(restored === savedDry, "dry_run restored to its pre-test value", String(restored));
} catch (e) {
  console.error(`\nSUITE CRASHED: ${(e as Error).message}`);
  fail++;
} finally {
  // Whatever happened above, the real pipeline must not be left altered.
  await cleanup().catch(() => {});
}

async function cleanupRows() {
  await sql`DELETE FROM outreach_drafts WHERE batch_id = ${TEST_BATCH}`;
  await sql`DELETE FROM digests WHERE batch_id = ${TEST_BATCH}`;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
