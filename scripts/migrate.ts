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

  /*
   * Lane A used to compose an email and send it in the same breath, which meant
   * there was no moment at which a human could read one. These two tables put a
   * reviewable draft in between: compose and validate up front, show the batch,
   * then send only what was approved.
   */
  ["outreach_drafts table",
    `CREATE TABLE IF NOT EXISTS outreach_drafts (
       id              BIGSERIAL PRIMARY KEY,
       batch_id        TEXT NOT NULL,
       listing_id      TEXT NOT NULL,
       to_address      TEXT NOT NULL,
       subject         TEXT NOT NULL,
       salutation      TEXT NOT NULL,
       body            TEXT NOT NULL,
       status          TEXT NOT NULL DEFAULT 'draft',
       blocked_reason  TEXT,
       provider        TEXT,
       provider_msg_id TEXT,
       gmail_thread_id TEXT,
       created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
       decided_at      TIMESTAMPTZ,
       sent_at         TIMESTAMPTZ
     )`],
  ["outreach_drafts status check",
    `ALTER TABLE outreach_drafts DROP CONSTRAINT IF EXISTS outreach_drafts_status_check`],
  ["outreach_drafts status values",
    `ALTER TABLE outreach_drafts ADD CONSTRAINT outreach_drafts_status_check
       CHECK (status IN ('draft','blocked','approved','sent','failed','skipped'))`],
  ["outreach_drafts batch index",
    `CREATE INDEX IF NOT EXISTS outreach_drafts_batch_idx ON outreach_drafts (batch_id)`],
  // One draft per address per batch. Staging twice must not queue the same
  // person twice; the send-side unique index on sends is the last line, not the
  // only one.
  ["outreach_drafts one per address per batch",
    `CREATE UNIQUE INDEX IF NOT EXISTS outreach_drafts_batch_addr
       ON outreach_drafts (batch_id, to_address)`],

  ["digests table",
    `CREATE TABLE IF NOT EXISTS digests (
       batch_id            TEXT PRIMARY KEY,
       telegram_chat_id    BIGINT,
       telegram_message_id BIGINT,
       status              TEXT NOT NULL DEFAULT 'pending',
       n_drafts            INTEGER NOT NULL DEFAULT 0,
       created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
       decided_at          TIMESTAMPTZ
     )`],
  ["digests status check",
    `ALTER TABLE digests DROP CONSTRAINT IF EXISTS digests_status_check`],
  ["digests status values",
    `ALTER TABLE digests ADD CONSTRAINT digests_status_check
       CHECK (status IN ('pending','sending','sent','skipped'))`],

  /*
   * When an unreviewed batch sends itself anyway.
   *
   * Requiring a tap meant three consecutive days produced nothing: the batch
   * was posted, nobody pressed, and the drafts simply aged. A deadline keeps
   * the review genuinely optional — press to send now, or let it go on its
   * own. NULL means "wait indefinitely", which is what the Hold button sets.
   */
  ["digests.auto_release_at",
    `ALTER TABLE digests ADD COLUMN IF NOT EXISTS auto_release_at TIMESTAMPTZ`],
  ["digests.auto_released",
    `ALTER TABLE digests ADD COLUMN IF NOT EXISTS auto_released BOOLEAN NOT NULL DEFAULT false`],
  /*
   * Phase 1 — reach. 90 of 101 recent high-fit listings had no address in the
   * feed. contact_probe_at records that discovery looked, so no posting is
   * ever fetched twice; description keeps the posting text for the writer.
   */
  ["listings.contact_probe_at",
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_probe_at TIMESTAMPTZ`],
  ["listings.description",
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS description TEXT`],
  // The feed's own statement of who may apply ("USA Only", "Worldwide"). Kept
  // so re-scoring can re-apply eligibility after a listing leaves the feeds.
  ["listings.location",
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS location TEXT`],
  /*
   * Apply kits — eligible, high-fit jobs whose employer takes applications
   * through a form, not an email. 193 of 213 eligible matches in one 30-day
   * window were form-only. The engine writes the cover letter and posts the
   * link; he submits it himself and confirms. Submitting a form on his behalf
   * would breach those sites' terms, so no code path does.
   */
  ["apply_kits table",
    `CREATE TABLE IF NOT EXISTS apply_kits (
       id                  BIGSERIAL PRIMARY KEY,
       listing_id          TEXT NOT NULL UNIQUE,
       body                TEXT NOT NULL,
       status              TEXT NOT NULL DEFAULT 'pending',
       blocked_reason      TEXT,
       telegram_chat_id    BIGINT,
       telegram_message_id BIGINT,
       created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
       decided_at          TIMESTAMPTZ
     )`],
  ["apply_kits status check",
    `ALTER TABLE apply_kits DROP CONSTRAINT IF EXISTS apply_kits_status_check`],
  ["apply_kits status values",
    `ALTER TABLE apply_kits ADD CONSTRAINT apply_kits_status_check
       CHECK (status IN ('pending','applied','skipped','blocked'))`],
  // A confirmed form application is recorded in sends as lane 'form'. The old
  // check allowed only 'auto' and 'approve', so the first "I applied" tap would
  // have thrown — caught before deploy by reading the constraint.
  ["sends lane check widened",
    `ALTER TABLE sends DROP CONSTRAINT IF EXISTS sends_lane_check`],
  ["sends lane values",
    `ALTER TABLE sends ADD CONSTRAINT sends_lane_check
       CHECK (lane IN ('auto','approve','form'))`],
  ["pipeline_state seed: daily_cap_kits",
    `INSERT INTO pipeline_state (key, value) VALUES ('daily_cap_kits', '8'::jsonb)
       ON CONFLICT (key) DO NOTHING`],
  ["digests release index",
    `CREATE INDEX IF NOT EXISTS digests_release_idx
       ON digests (auto_release_at) WHERE status = 'pending'`],
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
