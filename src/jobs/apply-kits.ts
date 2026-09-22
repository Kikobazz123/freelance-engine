import { guard } from "../lib/db.js";
import { buildKits, postKits, kitRoom, retireIneligibleKits } from "../lib/kits.js";

/**
 * Morning apply kits for form-only jobs, after the email batch has gone up.
 *
 * Nothing here submits anything: it writes a validated cover letter and posts
 * the apply link to Telegram, where he submits by hand and taps "I applied".
 * Respects the pipeline's kill switch like every other outward-facing task, and
 * a daily cap (daily_cap_kits, default 8) because each kit costs him a couple of
 * minutes and a pile he cannot get through helps nobody.
 */

export type Log = (msg: string, data?: unknown) => void;

/**
 * Job body, runner-agnostic. Called by the Inngest function (src/inngest) and,
 * until the cutover is complete, by the Trigger.dev wrapper in src/trigger.
 */
export async function runApplyKits(log: Log = () => {}) {
    const g = await guard();
    // Kits post to Telegram, not to employers, so dry run does not stop them —
    // but a paused pipeline means paused, so `enabled` does.
    if (!g.send && /disabled/.test(g.reason)) {
      log("pipeline disabled, no kits", { reason: g.reason });
      return { built: 0, posted: 0, reason: g.reason };
    }

    const withdrawn = await retireIneligibleKits();
    if (withdrawn) log("withdrew kits that no longer qualify", { withdrawn });

    const room = await kitRoom();
    if (!room) return { built: 0, posted: 0, reason: "daily kit cap reached" };

    const { built, blocked, ids } = await buildKits(room, (s) => log(s));
    const posted = await postKits(ids);
    log("apply kits", { room, built, blocked, posted });
    return { room, built, blocked, posted };
}
