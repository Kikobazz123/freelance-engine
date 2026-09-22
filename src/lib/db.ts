import { neon } from "@neondatabase/serverless";

/**
 * Single DB entry point. Neon's serverless driver is HTTP-based, so it works
 * inside Trigger.dev tasks without connection-pool management.
 */
type NeonSql = ReturnType<typeof neon>;

let _sql: NeonSql | null = null;

/**
 * Lazy: resolving at import time would throw during bundling, before env loads.
 * Memoised so we do not rebuild the client on every query.
 */
function conn(): NeonSql {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  _sql = neon(url);
  return _sql;
}

/**
 * Query entry point, supporting both forms the driver accepts:
 *   sql`SELECT ...`                  tagged template
 *   sql("SELECT ... $1", [param])    ordinary call, for dynamic SQL
 *
 * A plain variadic function, not a Proxy — the apply trap only fires when the
 * proxy target is itself callable, so proxying `{}` produced "sql is not a
 * function" at the first real query. Note the driver exposes no `.query()`
 * method; the ordinary call form above is its equivalent.
 */
export const sql: NeonSql = ((...args: unknown[]) =>
  (conn() as unknown as (...a: unknown[]) => unknown)(...args)) as NeonSql;

/* ------------------------------------------------------------ pipeline state */

export type StateKey =
  | "enabled"
  | "dry_run"
  | "daily_cap_auto"
  | "daily_cap_approve"
  | "rate_floor_hourly"
  | "telegram_offset";

export async function getState<T = unknown>(key: StateKey, fallback: T): Promise<T> {
  const rows = (await conn()`
    SELECT value FROM pipeline_state WHERE key = ${key}
  `) as { value: T }[];
  return rows.length ? rows[0].value : fallback;
}

export async function setState(key: StateKey, value: unknown): Promise<void> {
  await conn()`
    INSERT INTO pipeline_state (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

/**
 * Two independent brakes, checked before anything leaves the machine.
 *
 * `enabled=false` is the hard stop the user controls from Telegram (/pause).
 * `dry_run=true` is the default and means generate everything, send nothing —
 * it stays on until a full end-to-end run has been inspected by hand.
 *
 * Env vars override the database in the safe direction only: env can force a
 * halt, it can never switch sending on. A stale `DRY_RUN=false` left in a shell
 * must not be able to start live sending on its own.
 */
export async function guard(): Promise<{ send: boolean; reason: string }> {
  const enabled = await getState<boolean>("enabled", true);
  if (!enabled) return { send: false, reason: "pipeline disabled (pipeline_state.enabled=false)" };

  if (process.env.PIPELINE_ENABLED === "false") {
    return { send: false, reason: "pipeline disabled (PIPELINE_ENABLED=false)" };
  }

  const dbDry = await getState<boolean>("dry_run", true);
  const envDry = process.env.DRY_RUN !== "false";
  if (dbDry || envDry) {
    return { send: false, reason: `dry run (db=${dbDry} env=${envDry})` };
  }

  return { send: true, reason: "live" };
}

/** Sends already made today, per lane — enforces the daily caps. */
export async function sentToday(lane: "auto" | "approve"): Promise<number> {
  const rows = (await conn()`
    SELECT count(*)::int AS n
    FROM sends
    WHERE lane = ${lane}
      AND dry_run = false
      AND sent_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')
  `) as { n: number }[];
  return rows[0]?.n ?? 0;
}

/* -------------------------------------------------------- bulk listing upsert */

export type ListingUpsert = {
  id: string; source: string; tier: string; lane: string;
  title: string; company: string; url: string;
  rate_min: number | ""; rate_max: number | ""; rate_type: string;
  posted_at: string; stack_tags: string; red_flags: string;
  fit_score?: number | ""; score_why?: string;
  market?: string; market_tier?: number; market_confidence?: string;
  market_signal?: string;
  contact_email?: string; contact_source?: string;
  description?: string;
  location?: string;
};

/**
 * Upsert listings in chunks.
 *
 * Deliberately not one round trip per row: a harvest returns ~1000 listings and
 * Neon's driver is HTTP, so row-at-a-time took minutes and would exceed the
 * task's 300s maxDuration in production. Chunked multi-row VALUES turns that
 * into ~10 requests.
 *
 * `scoreToo=false` leaves fit_score alone so the harvest task cannot clobber
 * scores that score.ts owns.
 */
export async function upsertListings(
  rows: ListingUpsert[],
  opts: { scoreToo?: boolean; chunk?: number } = {},
): Promise<{ inserted: number; total: number }> {
  const { scoreToo = false, chunk = 100 } = opts;
  const db = conn();
  let inserted = 0;

  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = slice.map((r) => {
      const base = params.length;
      params.push(
        r.id, r.source, r.tier, r.lane, r.title, r.company, r.url,
        r.rate_min === "" ? null : r.rate_min,
        r.rate_max === "" ? null : r.rate_max,
        r.rate_type || null,
        r.posted_at && !Number.isNaN(Date.parse(r.posted_at))
          ? new Date(r.posted_at).toISOString() : null,
        r.stack_tags ? r.stack_tags.split("|").filter(Boolean) : [],
        r.red_flags ? r.red_flags.split("|").filter(Boolean) : [],
        scoreToo ? (r.fit_score === "" ? null : r.fit_score) : null,
        scoreToo ? (r.score_why ?? null) : null,
        r.market ?? null, r.market_tier ?? null,
        r.market_confidence ?? null, r.market_signal ?? null,
        r.contact_email || null, r.contact_source || null,
        r.description || null,
        r.location || null,
      );
      const p = (n: number) => `$${base + n}`;
      return `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},` +
             `${p(8)}::int,${p(9)}::int,${p(10)},${p(11)}::timestamptz,` +
             `${p(12)}::text[],${p(13)}::text[],${p(14)}::int,${p(15)},` +
             `${p(16)},${p(17)}::smallint,${p(18)},${p(19)},${p(20)},${p(21)},${p(22)},${p(23)})`;
    });

    const setScore = scoreToo
      ? `, fit_score = EXCLUDED.fit_score, score_why = EXCLUDED.score_why`
      : ``;

    const res = (await db(
      `INSERT INTO listings (
         id, source, tier, lane, title, company, url,
         rate_min, rate_max, rate_type, posted_at, stack_tags, red_flags,
         fit_score, score_why, market, market_tier, market_confidence, market_signal,
         contact_email, contact_source, description, location
       ) VALUES ${tuples.join(",")}
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now(),
         stack_tags = EXCLUDED.stack_tags, red_flags = EXCLUDED.red_flags,
         market = EXCLUDED.market, market_tier = EXCLUDED.market_tier,
         market_confidence = EXCLUDED.market_confidence,
         market_signal = EXCLUDED.market_signal,
         contact_email = coalesce(EXCLUDED.contact_email, listings.contact_email),
         contact_source = coalesce(EXCLUDED.contact_source, listings.contact_source),
         description = coalesce(EXCLUDED.description, listings.description),
         location = coalesce(EXCLUDED.location, listings.location)${setScore}
       RETURNING (xmax = 0) AS is_new`,
      params,
    )) as unknown as { is_new: boolean }[];

    inserted += res.filter((r) => r.is_new).length;
  }

  const [{ n }] = (await db`SELECT count(*)::int AS n FROM listings`) as { n: number }[];
  return { inserted, total: n };
}

/* ------------------------------------------------------------- bid budget */

export type Platform = "freelancer" | "upwork";

/** Free-tier monthly allowances. Both verified against the platforms' own docs. */
export const FREE_ALLOWANCE: Record<Platform, { n: number; unit: string }> = {
  freelancer: { n: 6, unit: "bid" },
  upwork: { n: 10, unit: "connect" },
};

/** Which platform a listing source bids on, or null if it costs nothing to apply. */
export function platformOf(source: string): Platform | null {
  if (source.startsWith("Freelancer-")) return "freelancer";
  if (source.startsWith("Upwork")) return "upwork";
  return null;
}

/**
 * Remaining free allowance this calendar month, creating the row on first use.
 *
 * Budget is tracked rather than assumed because the whole marketplace lane is
 * ~8 bids a MONTH on the free tier. Spending one on a mediocre listing is a real
 * loss, so every approval has to be a conscious decision with the count visible.
 */
export async function bidBudget(
  p: Platform,
): Promise<{ allowance: number; spent: number; left: number; unit: string }> {
  const { n, unit } = FREE_ALLOWANCE[p];
  await conn()`
    INSERT INTO bid_budget (platform, period, allowance, spent, unit)
    VALUES (${p}, date_trunc('month', now())::date, ${n}, 0, ${unit})
    ON CONFLICT (platform, period) DO NOTHING
  `;
  const rows = (await conn()`
    SELECT allowance, spent, unit FROM bid_budget
    WHERE platform = ${p} AND period = date_trunc('month', now())::date
  `) as { allowance: number; spent: number; unit: string }[];
  const r = rows[0] ?? { allowance: n, spent: 0, unit };
  return { ...r, left: Math.max(0, r.allowance - r.spent) };
}

/**
 * Record a spend. `cost` is 1 bid on Freelancer, but on Upwork a proposal costs
 * a variable number of Connects, so the caller passes the real figure.
 */
export async function spendBid(p: Platform, cost = 1): Promise<void> {
  await conn()`
    UPDATE bid_budget SET spent = spent + ${cost}
    WHERE platform = ${p} AND period = date_trunc('month', now())::date
  `;
}
