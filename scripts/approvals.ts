/**
 * Local long-poller — instant button response while you work through a batch.
 *
 * The scheduled task polls every 5 minutes, which is fine for a card that arrives
 * overnight but poor when you are sitting there tapping Approve. This holds a long
 * poll open so presses register in under a second. Ctrl-C to stop; the scheduled
 * task carries on regardless.
 *
 * Shares the same offset row as the scheduled task, so whichever runs first wins
 * and no press is processed twice.
 *
 *   npm run approvals
 */

import "dotenv/config";
import { getState, setState } from "../src/lib/db.js";
import { getUpdates } from "../src/lib/telegram.js";
import { handleCallback } from "../src/lib/decisions.js";
import { handleCommand, pendingCount } from "../src/lib/commands.js";

const POLL_SECONDS = 25;

let running = true;
process.on("SIGINT", () => {
  console.log("\nstopping...");
  running = false;
});

console.log(`long-polling Telegram every ${POLL_SECONDS}s. Ctrl-C to stop.`);
// A database blip must not stop the watcher before it has started.
try {
  console.log(`${await pendingCount()} proposal(s) awaiting a decision.\n`);
} catch {
  console.log(`(could not reach the database for a pending count — starting anyway)\n`);
}

let consecutiveErrors = 0;

while (running) {
  try {
    /*
     * This read USED to sit outside the try, and that killed the watcher.
     *
     * Neon resolves through DNS on every call, and a single ENOTFOUND threw
     * from here — outside any handler — so the loop exited and every button
     * press after that went unanswered until someone noticed. The backoff
     * below was already correct; it just never got the chance to run.
     *
     * Everything that can touch the network now lives inside the try.
     */
    const offset = await getState<number>("telegram_offset", 0);
    const { callbacks, commands, nextOffset } = await getUpdates(offset, POLL_SECONDS);

    for (const cb of callbacks) {
      const t0 = Date.now();
      try {
        const r = await handleCallback(cb);
        console.log(`  ${new Date().toLocaleTimeString()}  ${r.action} -> ${r.result}  (${Date.now() - t0}ms)`);
      } catch (e) {
        console.log(`  ${new Date().toLocaleTimeString()}  ${cb.data} -> ERROR ${String((e as Error).message).slice(0, 80)}`);
      }
    }
    for (const c of commands) {
      const r = await handleCommand(c.text);
      console.log(`  ${new Date().toLocaleTimeString()}  ${c.text} -> ${r}`);
    }

    if (nextOffset !== offset) await setState("telegram_offset", nextOffset);
    consecutiveErrors = 0;
  } catch (e) {
    // This machine's connection drops intermittently; a failed poll is not a
    // reason to exit. Back off, then carry on.
    consecutiveErrors++;
    const wait = Math.min(30_000, 2000 * consecutiveErrors);
    console.log(`  poll failed (${String((e as Error).message).slice(0, 60)}) — retry in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

console.log("stopped.");
process.exit(0);
