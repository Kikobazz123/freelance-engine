import { guard, getState, sentToday } from "../lib/db.js";
import { stageBatch } from "../lib/drafts.js";
import { postDigest } from "../lib/digest.js";
import { sendPlain } from "../lib/telegram.js";

/**
 * Lane A morning run — compose the day's applications and put them up for one
 * tap.
 *
 * This task used to compose and send in the same pass. It no longer sends. The
 * reason is not caution for its own sake: it was the only part of the pipeline
 * where nobody ever saw an email before its recipient did. The claim validator
 * catches what it has patterns for, and it is good — it blocked three
 * fabricated LangChain/AWS claims on the first live batch — but "no pattern
 * matched" is not the same as "this reads well to a hiring manager".
 *
 * So the morning run now stages drafts and posts a rundown with a single
 * button. One tap sends all of them. The gates are unchanged and all still
 * apply at the moment of sending, in src/lib/drafts.ts:
 *
 *   1. guard()            dry_run / enabled, re-read inside sendBatch
 *   2. suppression        re-checked per draft at send time, not just at staging
 *   3. one-per-address    a unique index in the DB, not just a query
 *   4. batch size         fixed when the batch is staged, and printed on the button
 *   5. no stubs           an unusable LLM cannot produce a sendable draft
 *   6. claim validation   runs at staging; a violation is stored as 'blocked'
 *                         and shown in the rundown rather than silently dropped
 *   7. gmailSend(dryRun)  short-circuits before the network regardless
 *
 * NOTHING HERE SENDS. If the button is never pressed, nothing goes out that
 * day — the drafts simply stay available for the next batch. A button that says
 * "approve and send" has to be the thing that causes the sending, or it is
 * decoration.
 */

export type Log = (msg: string, data?: unknown) => void;

/**
 * Job body, runner-agnostic. Called by the Inngest function (src/inngest) and,
 * until the cutover is complete, by the Trigger.dev wrapper in src/trigger.
 */
export async function runSendLaneA(log: Log = () => {}) {
    const g = await guard();
    const cap = await getState<number>("daily_cap_auto", 10);
    const already = await sentToday("auto");
    const room = Math.max(0, cap - already);

    if (room === 0) {
      log("daily cap already reached, not staging", { cap, already });
      return { staged: 0, blocked: 0, reason: "cap reached" };
    }

    // The batch size is decided here and printed on the button, so what is read
    // in the rundown is exactly what one tap will send.
    const { batchId, staged, blocked } = await stageBatch(room, (s) => log(s));

    if (!staged && !blocked) {
      log("no new candidates to stage");
      return { staged: 0, blocked: 0, reason: "no candidates" };
    }

    const r = await postDigest(batchId);

    if (!g.send) {
      await sendPlain(
        `Heads up: ${r.sendable} draft${r.sendable === 1 ? "" : "s"} are ready, but the ` +
        `pipeline is held (${g.reason}). Approving will not send until that clears.`,
      );
    }

    log("lane A staged", {
      batchId, staged, blocked, posted: r.messages, mode: g.reason,
    });
    return { batchId, staged, blocked, posted: r.messages, mode: g.reason };
}
