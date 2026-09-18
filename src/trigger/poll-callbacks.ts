import { schedules, logger } from "@trigger.dev/sdk";
import { getState, setState } from "../lib/db.js";
import { getUpdates } from "../lib/telegram.js";
import { handleCallback } from "../lib/decisions.js";
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
 */
export const pollCallbacks = schedules.task({
  id: "poll-callbacks",
  cron: { pattern: "*/5 5-22 * * *", timezone: "Africa/Lagos" },
  maxDuration: 120,
  run: async () => {
    const offset = await getState<number>("telegram_offset", 0);

    // timeout 0: return immediately with whatever is queued. Long-polling inside a
    // scheduled run would just burn compute waiting.
    const { callbacks, commands, nextOffset } = await getUpdates(offset, 0);

    if (!callbacks.length && !commands.length) {
      // Still advance: Telegram redelivers until the offset moves, and a stuck
      // offset would replay every old update on every run.
      if (nextOffset !== offset) await setState("telegram_offset", nextOffset);
      return { callbacks: 0, commands: 0 };
    }

    const results: string[] = [];
    for (const cb of callbacks) {
      try {
        const r = await handleCallback(cb);
        results.push(`${r.action}=${r.result}`);
      } catch (e) {
        // One bad callback must not block the offset advance, or it poisons every
        // later poll by replaying forever.
        logger.error("callback failed", {
          data: cb.data, error: String((e as Error).message).slice(0, 200),
        });
        results.push(`${cb.data}=error`);
      }
    }

    for (const c of commands) {
      try {
        results.push(`cmd:${await handleCommand(c.text)}`);
      } catch (e) {
        logger.error("command failed", {
          text: c.text, error: String((e as Error).message).slice(0, 200),
        });
      }
    }

    // Advance only after processing. A crash before this point replays the batch,
    // which is safe because every handler is idempotent.
    await setState("telegram_offset", nextOffset);

    logger.info("callbacks drained", {
      callbacks: callbacks.length, commands: commands.length, results,
    });
    return { callbacks: callbacks.length, commands: commands.length, results };
  },
});
