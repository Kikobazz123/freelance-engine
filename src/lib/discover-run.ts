/**
 * Batch driver for discovery: pick candidates, probe them politely, record
 * every outcome.
 *
 * Kept apart from discover.ts so the fetching logic has no database
 * dependency and can be tested on saved HTML alone.
 */

import { sql } from "./db.js";
import { discoverContact, TRANSIENT } from "./discover.js";

const CONCURRENCY = 3;

export type DiscoverResult = {
  probed: number; found: number; viaPosting: number; viaCareers: number;
  reasons: Record<string, number>;
};

/**
 * Candidates: the listings Lane A would email if only it had an address.
 *
 * Same bar as staging (auto lane, fit >= 65, not Tier 3, not abusive or
 * unpaid), seen within 30 days so the address is likely still live, and never
 * probed before — contact_probe_at makes every URL a one-time request.
 */
async function candidates(limit: number) {
  return (await sql`
    SELECT id, url, source, fit_score, company FROM listings
    WHERE lane = 'auto'
      AND contact_email IS NULL
      AND contact_probe_at IS NULL
      AND fit_score >= 65
      AND coalesce(market_tier, 0) <> 3
      AND NOT ('abuse' = ANY(red_flags)) AND NOT ('unpaid' = ANY(red_flags))
      AND last_seen_at > now() - interval '30 days'
    ORDER BY rank_score DESC NULLS LAST, last_seen_at DESC
    LIMIT ${limit}
  `) as { id: string; url: string; source: string; fit_score: number; company: string | null }[];
}

export async function discoverListings(
  limit: number,
  opts: { dry?: boolean; log?: (s: string) => void } = {},
): Promise<DiscoverResult> {
  const log = opts.log ?? (() => {});
  const rows = await candidates(limit);
  const res: DiscoverResult = { probed: 0, found: 0, viaPosting: 0, viaCareers: 0, reasons: {} };

  const queue = [...rows];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const r = queue.shift()!;
      const d = await discoverContact(r.url, r.company);
      res.probed++;

      if (d.email !== null) {
        res.found++;
        d.via === "posting" ? res.viaPosting++ : res.viaCareers++;
        log(`  FOUND  ${d.email.padEnd(34)} via ${d.via.padEnd(8)} [${r.source}] fit ${r.fit_score}`);
      } else {
        res.reasons[d.reason] = (res.reasons[d.reason] ?? 0) + 1;
        log(`  none   ${d.reason.padEnd(34)} [${r.source}] ${r.url.slice(0, 70)}`);
      }

      if (opts.dry) continue;

      // Record every attempt, hit or miss, so no URL is ever fetched twice.
      if (d.email !== null) {
        await sql`
          UPDATE listings
          SET contact_probe_at = now(), contact_email = ${d.email},
              contact_source = ${`page:${d.via}`}
          WHERE id = ${r.id}
        `;
      } else if (TRANSIENT.test(d.reason)) {
        // A timeout is not the site's answer. Leave it unprobed so the next
        // run tries again, instead of hiding the listing for good.
        res.reasons["(will retry) " + d.reason] = (res.reasons["(will retry) " + d.reason] ?? 0) + 1;
      } else {
        await sql`UPDATE listings SET contact_probe_at = now() WHERE id = ${r.id}`;
      }
    }
  }));

  return res;
}
