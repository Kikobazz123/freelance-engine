/**
 * Find the apply address a feed left out, by reading the posting itself.
 *
 * Measured: of the auto-lane listings scoring >= 65 in the last 30 days, 90 of
 * 101 had no contact email in the feed. Scoring was not the bottleneck; reach
 * was. Feeds truncate descriptions and drop the "email jobs@..." line, but the
 * posting page — or the company careers page it links to — usually still has it.
 *
 * The rules that make Lane A legitimate do not relax here. The address still
 * has to be published by the employer, on the posting or on the careers page the
 * posting links to, and it still has to pass extractContact() unchanged: no free
 * mail, no noreply, and it must sit near language inviting contact. A mailto:
 * link is rewritten as "email <address>" so it goes through those same filters
 * rather than around them.
 *
 * Politeness: one fetch of the posting, at most one hop to a linked careers page,
 * robots.txt honoured, a timeout, a size cap, and callers record every attempt so
 * no URL is ever fetched twice.
 */

import { extractContact } from "./contact.js";
import { strip } from "./sources.js";

const UA = "Mozilla/5.0 (compatible; freelance-engine/0.1; personal job search)";
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1_500_000;

/**
 * Hosted application forms. Their pages hold a form, not an address, and a
 * second hop into one is a wasted request. The first-hop posting page on these
 * hosts is still read, because a few do print an address in the description.
 */
const FORM_HOSTS = [
  "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "bamboohr.com",
  "smartrecruiters.com", "recruitee.com", "breezy.hr", "jobvite.com",
  "icims.com", "myworkdayjobs.com", "teamtailor.com", "personio.de",
  "rippling.com", "wellfound.com", "linkedin.com", "indeed.com",
];

/** Never worth a hop: the aggregator we came from, or social and asset hosts. */
const NO_HOP_HOSTS = [
  "news.ycombinator.com", "ycombinator.com", "weworkremotely.com", "remotive.com",
  "remoteok.com", "jobicy.com", "himalayas.app", "twitter.com", "x.com",
  "facebook.com", "instagram.com", "youtube.com", "github.com", "medium.com",
  "google.com", "apple.com", "cloudflare.com", "fonts.googleapis.com",
];

/**
 * Addresses belonging to the board, never to the employer.
 *
 * The first dry run found hn@ycombinator.com on four Hacker News postings — it
 * is the contact line in HN's own footer, and it sits next to the word
 * "Contact", so extractContact rightly accepted it as invitation language.
 * Unguarded, the pipeline would have emailed Y Combinator a job application four
 * times. An address on the board's own domain is the board talking, not the
 * employer.
 */
const BOARD_DOMAINS = [
  "ycombinator.com", "weworkremotely.com", "remotive.com", "remoteok.com",
  "remoteok.io", "jobicy.com", "himalayas.app", "python.org", "producthunt.com",
  "jobspresso.co", "hasjob.co", "larajobs.com", "golangprojects.com",
  "cryptocurrencyjobs.co", "workingnomads.com", "arbeitnow.com", "reddit.com",
];

/**
 * Transient failures on our side. These must NOT be recorded as a completed
 * probe, or a flaky connection permanently hides a listing from discovery.
 * A 403 or 404 is the site's answer and is final; a timeout is not an answer.
 */
export const TRANSIENT = /fetch failed|aborted|timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|HTTP 5\d\d|HTTP 429/i;

export type Discovery =
  | { email: string; via: "posting" | "careers"; url: string }
  | { email: null; reason: string };

const onBoardDomain = (email: string) => {
  const d = email.split("@")[1] ?? "";
  return BOARD_DOMAINS.some((b) => d === b || d.endsWith("." + b));
};

/** Letters-only company tokens long enough to be distinctive: "Search Atlas" -> ["search","atlas"]. */
const companyTokens = (company: string | null | undefined): string[] =>
  (company ?? "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|corp|co|the|labs?|technologies|technology|group|hq)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);

const hostOf = (u: string): string => {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
};
const onHost = (host: string, list: string[]) =>
  list.some((h) => host === h || host.endsWith("." + h));

/* ------------------------------------------------------------- robots.txt */

const robotsCache = new Map<string, string[]>();

/** Disallow prefixes that apply to us (the `*` group). Fails open on error. */
async function disallowed(origin: string): Promise<string[]> {
  if (robotsCache.has(origin)) return robotsCache.get(origin)!;
  let rules: string[] = [];
  try {
    const txt = await fetchText(`${origin}/robots.txt`, 64_000);
    let applies = false;
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (k.toLowerCase() === "user-agent") applies = v.trim() === "*";
      else if (applies && k.toLowerCase() === "disallow" && v.trim()) rules.push(v.trim());
    }
  } catch {
    rules = [];
  }
  robotsCache.set(origin, rules);
  return rules;
}

export async function robotsAllows(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const rules = await disallowed(u.origin);
    const path = u.pathname + u.search;
    return !rules.some((r) => r === "/" || path.startsWith(r));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ fetch */

async function fetchText(url: string, cap = MAX_BYTES): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.text();
    return body.length > cap ? body.slice(0, cap) : body;
  } finally {
    clearTimeout(t);
  }
}

/**
 * HTML to plain text that keeps the one thing stripping would lose: a mailto:
 * address becomes "email <address>", so it reaches extractContact as visible,
 * invitation-adjacent text and is judged by the same filters as everything else.
 */
export function pageText(html: string): string {
  const withMailto = html.replace(
    /<a\b[^>]*href\s*=\s*["']mailto:([^"'?]+)[^"']*["'][^>]*>/gi,
    (_m, addr: string) => ` email ${decodeURIComponent(addr)} `,
  );
  const noScripts = withMailto
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  return strip(noScripts);
}

/**
 * Links on the posting that plausibly lead to the employer's own careers or
 * apply page. Anchor text or URL must say so; the aggregator's own pages,
 * social sites and hosted forms are skipped.
 */
export function hopCandidates(html: string, base: string, company?: string | null): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const baseHost = hostOf(base);
  /*
   * A hop must land on the employer's own site. Without this a RemoteOK page's
   * "featured on Product Hunt" badge was followed, and hello@producthunt.com
   * came back as the employer's apply address. Matching the host against the
   * company name is crude, but a wrong hop is a wrong stranger emailed, so
   * crude-and-strict beats clever-and-loose. No company name, no hop.
   */
  const tokens = companyTokens(company);
  if (!tokens.length) return [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let href = m[1].trim();
    if (/^(mailto|tel|javascript):/i.test(href)) continue;
    try { href = new URL(href, base).toString(); } catch { continue; }
    const host = hostOf(href);
    if (!host || host === baseHost) continue;
    if (onHost(host, NO_HOP_HOSTS) || onHost(host, FORM_HOSTS)) continue;
    if (!tokens.some((t) => host.replace(/[^a-z0-9]/g, "").includes(t))) continue;
    const label = strip(m[2]).toLowerCase();
    if (/apply|career|jobs?\b|join|hiring|work with us|position/.test(label + " " + href.toLowerCase())) {
      out.push(href);
    }
  }
  return [...new Set(out)].slice(0, 3);
}

/**
 * A careers page carries every address the company has, not just the hiring
 * one. Following a link found lets-talk@mactores.com — a sales inbox that sat
 * near the word "contact" — and offered it as the apply address. On the posting
 * itself the context is the job, so the ordinary rules hold; one hop away, the
 * address must look like it is for applicants.
 */
const HIRING_LOCAL = /^(jobs?|careers?|hiring|hire|recruit\w*|talent|hr|apply|applications?|join|work|people|team|engineering|dev|tech|cv|resumes?)([._+-]|$)/i;

export function hiringInbox(email: string): boolean {
  return HIRING_LOCAL.test(email.split("@")[0] ?? "");
}

/** extractContact, minus anything the board itself published. */
export function employerContact(text: string) {
  // extractContact returns the first acceptable address; blank out board
  // addresses first so a footer cannot shadow the employer's line.
  const cleaned = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    (e) => (onBoardDomain(e.toLowerCase()) ? " " : e));
  return extractContact(cleaned);
}

/* ------------------------------------------------------------ the search */

/**
 * Look for an apply address on the posting, then on at most one linked careers
 * page. Never throws; every outcome is a Discovery the caller records.
 */
export async function discoverContact(
  postingUrl: string, company?: string | null,
): Promise<Discovery> {
  if (!(await robotsAllows(postingUrl))) return { email: null, reason: "robots_disallow" };

  let html: string;
  try {
    html = await fetchText(postingUrl);
  } catch (e) {
    return { email: null, reason: `fetch:${String((e as Error).message).slice(0, 40)}` };
  }

  const direct = employerContact(pageText(html));
  if (direct) return { email: direct.email, via: "posting", url: postingUrl };

  for (const hop of hopCandidates(html, postingUrl, company)) {
    if (!(await robotsAllows(hop))) continue;
    try {
      const h2 = await fetchText(hop);
      const found = employerContact(pageText(h2));
      if (found && hiringInbox(found.email)) return { email: found.email, via: "careers", url: hop };
    } catch {
      /* one dead link is not a reason to stop looking */
    }
    // Only ever one successful hop's worth of requests per posting.
    break;
  }

  return { email: null, reason: "no_address_published" };
}
