import { getState, setState } from "../lib/db.js";
import { getUpdates } from "../lib/telegram.js";
import { handleCallback, releaseDueBatches } from "../lib/decisions.js";
import { handleCommand } from "../lib/commands.js";

/**
 * Drain Telegram button presses and slash commands.
 *
 * Polling rather than a webhook, deliberately: a webhook needs a public HTTPS
 * endpoint, which means hosting, which means cost. Polling keeps the whole system
 * on free tiers and the only price is latency.
 *
 * Every 5 minutes, 05:00-22:00 WAT. That window is when approvals actually happen
 * (dispatch runs 05:30) and it keeps this at roughly 6,500 runs/month, well inside
 * the $5 Trigger.dev credit. Overnight presses are picked up at 05:00.
 *
 * For instant response while working through a morning batch, run the local
 * long-poller instead: `npm run approvals`.
 *
 * It also releases overdue batches. That used to be its own every-15-minutes
 * task, but Trigger.dev's free plan caps an account at 10 schedules and apply
 * kits needed the slot. Folding it in here is the natural fit — both are "react
 * to state" loops — and it releases within 5 minutes of a deadline rather than
 * 15. Button presses are handled FIRST, so a Hold or Approve tapped just before
 * a deadline always wins over the release.
 */

export type Log = (msg: string, data?: unknown) => void;

/**
 * Job body, runner-agnostic. Called by the Inngest function (src/inngest) and,
 * until the cutover is complete, by the Trigger.dev wrapper in src/trigger.
 */
export async function runPollCallbacks(log: Log = () => {}) {
    const offset = await getState<number>("telegram_offset", 0);

    // timeout 0: return immediately with whatever is queued. Long-polling inside a
    // scheduled run would just burn compute waiting.
    const { callbacks, commands, nextOffset } = await getUpdates(offset, 0);

    if (!callbacks.length && !commands.length) {
      // Still advance: Telegram redelivers until the offset moves, and a stuck
      // offset would replay every old update on every run.
      if (nextOffset !== offset) await setState("telegram_offset", nextOffset);
      const rel = await releaseDueBatches((s) => log(s));
      return { callbacks: 0, commands: 0, released: rel.released };
    }

    const results: string[] = [];
    for (const cb of callbacks) {
      try {
        const r = await handleCallback(cb);
        results.push(`${r.action}=${r.result}`);
      } catch (e) {
        // One bad callback must not block the offset advance, or it poisons every
        // later poll by replaying forever.
        log("callback failed", {
          data: cb.data, error: String((e as Error).message).slice(0, 200),
        });
        results.push(`${cb.data}=error`);
      }
    }

    for (const c of commands) {
      try {
        results.push(`cmd:${await handleCommand(c.text)}`);
      } catch (e) {
        log("command failed", {
          text: c.text, error: String((e as Error).message).slice(0, 200),
        });
      }
    }

    // Advance only after processing. A crash before this point replays the batch,
    // which is safe because every handler is idempotent.
    await setState("telegram_offset", nextOffset);

    // Presses first, deadlines second — see the header.
    const rel = await releaseDueBatches((s) => log(s));

    log("callbacks drained", {
      callbacks: callbacks.length, commands: commands.length, results, released: rel.released,
    });
    return { callbacks: callbacks.length, commands: commands.length, results, released: rel.released };
}
