import { sql, getState } from "../lib/db.js";
import { writeProposal } from "../lib/proposal.js";

/**
 * Draft a tailored proposal for each shortlisted listing that has none yet.
 *
 * Generation is decoupled from sending on purpose: everything is written and
 * reviewable before `dispatch` decides whether it may leave the machine.
 */

export type Log = (msg: string, data?: unknown) => void;

/**
 * Job body, runner-agnostic. Called by the Inngest function (src/inngest) and,
 * until the cutover is complete, by the Trigger.dev wrapper in src/trigger.
 */
export async function runGenerate(log: Log = () => {}) {
    const capAuto = await getState<number>("daily_cap_auto", 30);
    const capApprove = await getState<number>("daily_cap_approve", 15);

    const candidates = (await sql`
      SELECT l.*
      FROM listings l
      LEFT JOIN proposals p ON p.listing_id = l.id
      WHERE p.id IS NULL
        AND l.fit_score >= 65
        AND NOT ('abuse'  = ANY(l.red_flags))
        AND NOT ('unpaid' = ANY(l.red_flags))
      ORDER BY l.fit_score DESC, l.first_seen_at DESC
      LIMIT ${capAuto + capApprove}
    `) as any[];

    let made = 0, failed = 0;
    for (const l of candidates) {
      try {
        const { body, rate } = await writeProposal(l);
        await sql`
          INSERT INTO proposals (listing_id, body, rate_quoted, cv_variant, model, status)
          VALUES (${l.id}, ${body}, ${rate}, 'ai-automation-engineer',
                  ${process.env.PROPOSAL_MODEL ?? "claude-sonnet-5"}, 'draft')
          ON CONFLICT (listing_id) DO NOTHING
        `;
        made++;
      } catch (e) {
        // One bad listing must not abort the batch.
        log("proposal generation failed", {
          listingId: l.id, error: String((e as Error).message).slice(0, 200),
        });
        failed++;
      }
    }

    log("generation complete", { candidates: candidates.length, made, failed });
    return { made, failed };
}
