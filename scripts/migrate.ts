/**
 * Idempotent schema migrations. Every statement is IF NOT EXISTS / DO UPDATE so
 * this is safe to re-run.
 *
 *   tsx scripts/migrate.ts
 */

import "dotenv/config";
import { sql } from "../src/lib/db.js";

const STATEMENTS: [string, string][] = [
  ["proposals.telegram_message_id",
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT`],
  ["proposals.telegram_chat_id",
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT`],
  // Which platform budget an approval spent, and how much. Needed so a skip after
  // an approve can give the bid back rather than silently losing it.
  ["proposals.bid_cost",
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS bid_cost INTEGER NOT NULL DEFAULT 0`],
  ["proposals.bid_platform",
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS bid_platform TEXT`],
  ["proposals status check widened",
    `ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check`],
  ["proposals status check",
    `ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
       CHECK (status IN ('draft','pending_approval','approved','skipped','sent','failed'))`],
  ["listings.contact_email",
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_email TEXT`],
  ["listings.contact_source",
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_source TEXT`],
  ["listings contact index",
    `CREATE INDEX IF NOT EXISTS listings_contact_idx
       ON listings (contact_email) WHERE contact_email IS NOT NULL`],
  // Never write to the same address twice, and never again once someone opts out.
  ["suppression table",
    `CREATE TABLE IF NOT EXISTS suppression (
       email      TEXT PRIMARY KEY,
       reason     TEXT NOT NULL,
       added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
     )`],
  ["sends unique per address+proposal",
    `CREATE UNIQUE INDEX IF NOT EXISTS sends_addr_once
       ON sends (to_address) WHERE to_address IS NOT NULL AND dry_run = false`],
  // Lane A composes its email directly from the listing and has no proposal row,
  // so this cannot be NOT NULL. Caught by verify-lane-a before any live send.
  ["sends.proposal_id nullable",
    `ALTER TABLE sends ALTER COLUMN proposal_id DROP NOT NULL`],
  ["pipeline_state seed: telegram offset",
    `INSERT INTO pipeline_state (key, value) VALUES ('telegram_offset', '0'::jsonb)
       ON CONFLICT (key) DO NOTHING`],
];

for (const [name, stmt] of STATEMENTS) {
  try {
    await sql(stmt);
    console.log(`  OK    ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}: ${String((e as Error).message).slice(0, 100)}`);
  }
}

const cols = (await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'proposals' ORDER BY ordinal_position
`) as { column_name: string }[];
console.log(`\nproposals columns: ${cols.map((c) => c.column_name).join(", ")}`);
