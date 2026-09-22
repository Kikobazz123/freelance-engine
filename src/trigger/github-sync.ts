import { schedules, logger } from "@trigger.dev/sdk";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { sql } from "../lib/db.js";
import { buildEvidence, type RepoEvidence } from "../lib/github.js";
import { send as tg, esc } from "../lib/telegram.js";

/**
 * Keep the evidence base current with what has actually been shipped.
 *
 * Every claim this system makes traces to `profile/`, which was assembled by hand
 * from the repos that existed on one particular day. Without this, a repo pushed
 * next month never reaches a single proposal, and the CV slowly describes someone
 * who stopped working.
 *
 * Deliberately does NOT rewrite the profile or the CV on its own. Those carry
 * claims a human has vouched for, and an automated edit to them is an automated
 * claim. It writes a machine-readable evidence file, notes what changed, and asks.
 */
export const githubSync = schedules.task({
  id: "github-sync",
  cron: { pattern: "0 4 * * *", timezone: "Africa/Lagos" },
  maxDuration: 180,
  run: async () => {
    const evidence = await buildEvidence();
    const path = "profile/github-evidence.json";

    /*
     * The database is the source of truth; the file is a local convenience.
     *
     * This used to read and write profile/github-evidence.json first and mirror
     * to the database second. On Trigger.dev the profile/ directory does not
     * exist, so writeFileSync threw ENOENT before the database write ever ran —
     * every scheduled run failed, nothing was saved, and no new repo was ever
     * reported. It failed four days out of four without anyone noticing.
     */
    const stored = (await sql`
      SELECT value FROM pipeline_state WHERE key = 'github_evidence'
    `) as { value: RepoEvidence[] }[];
    const previous: RepoEvidence[] = stored[0]?.value
      ?? (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).repos ?? [] : []);
    const prevByName = new Map(previous.map((r) => [r.name, r]));

    const added = evidence.filter((r) => !prevByName.has(r.name));
    const updated = evidence.filter((r) => {
      const p = prevByName.get(r.name);
      return p && p.pushed_at !== r.pushed_at;
    });
    const newMetrics = evidence.filter((r) => {
      const p = prevByName.get(r.name);
      return p && r.metrics.length > p.metrics.length;
    });

    await sql`
      INSERT INTO pipeline_state (key, value, updated_at)
      VALUES ('github_evidence', ${JSON.stringify(evidence)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;

    // Local runs also refresh the file in the repo. Deployed runs have no
    // profile/ directory, and must not fail for the lack of one.
    if (existsSync("profile")) {
      writeFileSync(path, JSON.stringify({
        generated_at: new Date().toISOString(),
        repo_count: evidence.length,
        repos: evidence,
      }, null, 2), "utf8");
    }

    logger.info("github sync", {
      repos: evidence.length, added: added.length, updated: updated.length,
    });

    // Only interrupt for something that changes what can be claimed.
    if (added.length || newMetrics.length) {
      await tg([
        `*GitHub sync*`,
        `${evidence.length} repos tracked`,
        ...(added.length ? [``, `*New:*`, ...added.slice(0, 5).map(
          (r) => `· ${esc(r.name)}${r.language ? ` \\(${esc(r.language)}\\)` : ""}`)] : []),
        ...(newMetrics.length ? [``, `*New citable numbers:*`, ...newMetrics.slice(0, 5).map(
          (r) => `· ${esc(r.name)}: ${esc(r.metrics.slice(0, 3).join(", "))}`)] : []),
        ``,
        `_Profile and CV are not auto\\-edited — review and tell me what to add\\._`,
      ].join("\n"));
    }

    return {
      repos: evidence.length,
      added: added.map((r) => r.name),
      updated: updated.map((r) => r.name),
      newMetrics: newMetrics.map((r) => r.name),
    };
  },
});
