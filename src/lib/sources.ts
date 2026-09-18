/**
 * Canonical source registry and normalisation.
 *
 * Both `scripts/harvest.ts` (CLI, writes CSV) and `src/trigger/harvest.ts`
 * (scheduled, writes Neon) import from here, so the two can never drift.
 *
 * API/RSS-first by design: these are published feeds meant for consumption, so
 * ingesting them breaks no terms. Every endpoint below was verified live by
 * scripts/probe.mjs — guessed URLs are not kept.
 */

import { createHash } from "node:crypto";
import { marketOf, type MarketTier, type Confidence } from "./geo.js";
import { extractContact } from "./contact.js";

const UA = "Mozilla/5.0 (compatible; freelance-engine/0.1; personal job search)";
const TIMEOUT_MS = 20_000;

const KEYWORDS = [
  "ai", "llm", "gpt", "claude", "openai", "anthropic", "agent", "automation",
  "n8n", "zapier", "make.com", "rag", "langchain", "workflow", "integration",
  "prompt", "chatbot", "machine learning", "ml engineer", "python", "typescript",
  "node", "fastapi", "api", "scraping", "data pipeline", "etl", "backend",
];

const STACK: Record<string, RegExp> = {
  typescript: /\btypescript\b|\bts\b/i, javascript: /\bjavascript\b|\bnode\.?js\b/i,
  python: /\bpython\b/i, react: /\breact\b|\bnext\.?js\b/i,
  langchain: /\blangchain\b|\bllama.?index\b/i, n8n: /\bn8n\b/i,
  zapier: /\bzapier\b|\bmake\.com\b/i, openai: /\bopenai\b|\bgpt-?4|\bgpt-?5/i,
  claude: /\bclaude\b|\banthropic\b/i, rag: /\brag\b|\bvector\b|\bembedding/i,
  agents: /\bagent(s|ic)?\b/i, automation: /\bautomation\b|\bworkflow\b/i,
  postgres: /\bpostgres|\bsupabase\b|\bneon\b/i, aws: /\baws\b|\bgcp\b|\bazure\b/i,
  scraping: /\bscrap(e|ing)\b|\bcrawl/i, api: /\bapi\b|\bintegration\b/i,
};

export const RED_FLAGS: Record<string, RegExp> = {
  unpaid: /\bunpaid\b|\bequity only\b|\bno pay\b|\bvolunteer\b/i,
  equity_only: /\bequity[- ]only\b/i,
  us_only: /\b(?:us|usa|u\.s\.)[- ]?only\b|\bonly\b[^.]{0,20}\b(?:us|usa)\b|\bmust be (?:located |based )?in the (?:us|usa|united states)\b|\b(?:us|usa)[- ]based\b|\bus citizens? only\b|\bauthoriz(?:ed|ation) to work in the (?:us|united states)\b|\bw2\b|\bgreen card\b/i,
  eu_only: /\b(?:eu|uk|europe)[- ]?only\b|\bmust be (?:located |based )?in (?:the )?(?:eu|uk|europe)\b/i,
  onsite: /\bon[- ]?site\b|\bhybrid\b|\brelocat/i,
  clearance: /\bsecurity clearance\b|\bTS\/SCI\b/i,
  // Fraudulent / ToS-violating / reputation-destroying work. Hard-vetoed in scoring.
  //
  // Deliberately NOT here: bare /page views/ and bare /spam/. Both seemed obvious
  // and both were catastrophic — "page views" flagged every analytics role and
  // "spam" flagged anti-spam and email-deliverability work, 33 false positives in
  // one run. Sending intent only. Validated against a 13-case block/pass fixture.
  abuse: new RegExp([
    /\b(ad|view|click|follower|subscriber|like|stream)s?\s*(bot|farm|boost|generat)/,
    /\b(bot|fake|auto)\s*(views?|clicks?|followers?|likes?|accounts?|reviews?)\b/,
    /\bautomate\s+[\d,]+\s+(?:\w+\s+){0,4}?(views?|clicks?|accounts?|followers?|likes?|subscribers?)\b/,
    /\bcaptcha\s*(solv|bypass)/, /\bscrape\b[^.]{0,30}\bbypass\b/,
    /\bmass\s*(dm|email|account creation)\b/,
    /\b(send|blast|bulk)\w*\s+spam\b|\bspam\s*(bot|blast|campaign|farm)\b/,
    /\bessay\s*writ/, /\bghostwrite\b[^.]{0,20}\b(thesis|dissertation|assignment)\b/,
    /\bpump\s*(and|&)\s*dump\b/, /\bairdrop\s*farm/,
    /\bcrack\b|\bkeygen\b|\bnulled\b|\bbypass\s*(licen[cs]e|drm|paywall)\b/,
  ].map((r) => r.source).join("|"), "i"),
};

/** Someone offering services, not hiring. Competitors — routed away from the funnel. */
export const SEEKING_WORK =
  /\bseeking work\b|\bwants to be hired\b|\blooking for (?:a )?(?:new )?(?:role|work|position|opportunit)/i;

/* ---------------------------------------------------------------- helpers */

async function get(url: string, accept = "application/json"): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

export const strip = (s = ""): string =>
  String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#3[49];/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&mdash;/g, "-").replace(/&ndash;/g, "-")
    .replace(/&#8217;|&rsquo;/g, '\'').replace(/&hellip;/g, "...")
    .replace(/\s+/g, " ")
    .trim();

type Raw = {
  title: string; company?: string; url: string;
  description?: string; posted_at?: string; rate_hint?: string;
};

/** Minimal RSS/Atom extraction — avoids an XML dependency in the task bundle. */
function parseFeed(xml: string): Raw[] {
  const out: Raw[] = [];
  for (const b of xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/g) ?? []) {
    const tag = (n: string) => {
      const m = b.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, "i"));
      return m ? strip(m[1]) : "";
    };
    let link = tag("link");
    if (!link) link = b.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? "";
    out.push({
      title: tag("title"),
      url: link,
      description: tag("description") || tag("summary") || tag("content"),
      posted_at: tag("pubDate") || tag("published") || tag("updated"),
      company: tag("dc:creator") || tag("author") || "",
    });
  }
  return out;
}

export function parseRate(text = ""): [number | "", number | "", string] {
  const t = String(text);
  let m = t.match(/\$\s?(\d{1,3})\s?(?:-|–|to)\s?\$?\s?(\d{1,3})\s?(?:\/|\s?per\s?)\s?(?:hr|hour)/i);
  if (m) return [+m[1], +m[2], "hourly"];
  m = t.match(/\$\s?(\d{1,3})\s?(?:\/|\s?per\s?)\s?(?:hr|hour)/i);
  if (m) return [+m[1], +m[1], "hourly"];
  m = t.match(/\$\s?(\d{2,3})[,\s]?(\d{3})\s?(?:-|–|to)\s?\$?\s?(\d{2,3})[,\s]?(\d{3})/);
  if (m) return [+`${m[1]}${m[2]}`, +`${m[3]}${m[4]}`, "annual"];
  m = t.match(/\$\s?(\d{3,5})\s?(?:\/|\s?per\s?)\s?(?:mo|month)/i);
  if (m) return [+m[1], +m[1], "monthly"];
  return ["", "", ""];
}

const tagsFor = (t: string) =>
  Object.entries(STACK).filter(([, re]) => re.test(t)).map(([k]) => k).join("|");
const flagsFor = (t: string) =>
  Object.entries(RED_FLAGS).filter(([, re]) => re.test(t)).map(([k]) => k).join("|");
const relevant = (t: string) => {
  const l = t.toLowerCase();
  return KEYWORDS.some((k) => l.includes(k));
};

/* ------------------------------------------------------------ source defs */
// tier: A bidding | B vetted | C remote board | D ai-niche | F direct client
// lane: auto (email/ATS apply, ToS-clean) | approve (marketplace, human click)

type Source = {
  name: string; tier: string; lane: "auto" | "approve";
  type: "json" | "rss" | "custom";
  url?: string;
  map?: (d: any) => Raw[];
  fetch?: () => Promise<Raw[]>;
};

export const SOURCES: Source[] = [
  { name: "Remotive", tier: "C", lane: "auto", type: "json",
    url: "https://remotive.com/api/remote-jobs?category=software-dev&limit=120",
    map: (d) => (d.jobs ?? []).map((j: any) => ({
      title: j.title, company: j.company_name, url: j.url,
      description: `${j.title} ${strip(j.description).slice(0, 900)} ${j.salary ?? ""}`,
      posted_at: j.publication_date, rate_hint: j.salary ?? "",
    })) },

  ...["dev", "data-science", "business", "marketing"].map((ind): Source => ({
    name: `Jobicy-${ind}`, tier: "C", lane: "auto", type: "json",
    url: `https://jobicy.com/api/v2/remote-jobs?count=50&industry=${ind}`,
    map: (d) => (d.jobs ?? []).map((j: any) => ({
      title: j.jobTitle, company: j.companyName, url: j.url,
      description: `${j.jobTitle} ${strip(j.jobExcerpt)} ${(j.jobIndustry ?? []).join(" ")}`,
      posted_at: j.pubDate,
      rate_hint: j.annualSalaryMin ? `$${j.annualSalaryMin}-$${j.annualSalaryMax}` : "",
    })),
  })),

  ...["ai", "automation", "python"].map((tag): Source => ({
    name: `RemoteOK-${tag}`, tier: "D", lane: "auto", type: "json",
    url: `https://remoteok.com/api?tags=${tag}`,
    map: (d) => (Array.isArray(d) ? d.slice(1) : []).map((j: any) => ({
      title: j.position ?? j.title, company: j.company, url: j.url ?? j.apply_url,
      description: `${j.position ?? ""} ${(j.tags ?? []).join(" ")} ${strip(j.description).slice(0, 700)}`,
      posted_at: j.date,
      rate_hint: j.salary_min ? `$${j.salary_min}-$${j.salary_max}` : "",
    })),
  })),

  ...["devops", "data", "software-dev"].map((cat): Source => ({
    name: `Remotive-${cat}`, tier: "C", lane: "auto", type: "json",
    url: `https://remotive.com/api/remote-jobs?category=${cat}&limit=60`,
    map: (d) => (d.jobs ?? []).map((j: any) => ({
      title: j.title, company: j.company_name, url: j.url,
      description: `${j.title} ${strip(j.description).slice(0, 900)} ${j.salary ?? ""}`,
      posted_at: j.publication_date, rate_hint: j.salary ?? "",
    })),
  })),

  { name: "Himalayas-API", tier: "C", lane: "auto", type: "json",
    url: "https://himalayas.app/jobs/api?limit=100",
    map: (d) => (d.jobs ?? d.data ?? []).map((j: any) => ({
      title: j.title, company: j.companyName ?? j.company, url: j.applicationLink ?? j.url,
      description: `${j.title} ${strip(j.excerpt ?? j.description).slice(0, 700)}`,
      posted_at: j.pubDate ?? j.publishedDate,
      rate_hint: j.minSalary ? `$${j.minSalary}-$${j.maxSalary}` : "",
    })) },

  // Two-step. Searching comments directly returns the "who wants to be hired"
  // thread as well, which is competitors; and plain `search` ranks by relevance,
  // which returned threads from 2019. Hence search_by_date + newest-first.
  { name: "HN-WhoIsHiring", tier: "F", lane: "auto", type: "custom",
    fetch: async () => {
      const s = JSON.parse(await get(
        "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=20"
      ));
      const story = (s.hits ?? [])
        .filter((h: any) => /who is hiring/i.test(h.title ?? ""))
        .sort((a: any, b: any) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      if (!story) return [];
      const c = JSON.parse(await get(
        `https://hn.algolia.com/api/v1/search?tags=comment,story_${story.objectID}&hitsPerPage=600`
      ));
      return (c.hits ?? []).filter((h: any) => h.comment_text).map((h: any) => {
        const txt = strip(h.comment_text);
        return {
          title: txt.slice(0, 130),
          company: (txt.split("|")[0] ?? "HN").trim().slice(0, 60),
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          description: txt.slice(0, 1500),
          posted_at: h.created_at,
          rate_hint: txt,
        };
      });
    } },

  // --- RSS (all verified live) ---
  ...[
    ["WWR-All", "https://weworkremotely.com/remote-jobs.rss", "C"],
    ["WWR-FullStack", "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss", "C"],
    ["WWR-Programming", "https://weworkremotely.com/categories/remote-programming-jobs.rss", "C"],
    ["WWR-DevOps", "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss", "C"],
    ["WWR-Backend", "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss", "C"],
    ["Himalayas-RSS", "https://himalayas.app/jobs/rss?categories=software-engineering", "C"],
    ["Jobspresso", "https://jobspresso.co/?feed=job_feed", "C"],
    ["PythonJobs", "https://www.python.org/jobs/feed/rss/", "C"],
    ["Cryptocurrency-Jobs", "https://cryptocurrencyjobs.co/index.xml", "D"],
    ["Hasjob", "https://hasjob.co/feed", "C"],
    ["Golangprojects", "https://www.golangprojects.com/rss.xml", "C"],
    ["Larajobs", "https://larajobs.com/feed", "C"],
  ].map(([name, url, tier]): Source => ({
    name, tier, lane: "auto", type: "rss", url,
  })),

  { name: "Gun.io", tier: "B", lane: "approve", type: "rss", url: "https://gun.io/feed/" },

  // Marketplaces. lane:"approve" is load-bearing — nothing here is ever
  // auto-submitted, because that is exactly what gets accounts permanently banned.
  ...["automation", "ai agent", "python", "api integration", "chatbot"].map((kw): Source => ({
    name: `Freelancer-${kw.replace(/\s+/g, "-")}`, tier: "A", lane: "approve", type: "rss",
    url: `https://www.freelancer.com/rss.xml?keyword=${encodeURIComponent(kw)}`,
  })),
  { name: "Codeur", tier: "A", lane: "approve", type: "rss", url: "https://www.codeur.com/projects.rss" },
];

/* ------------------------------------------------------------------- run */

export type Listing = {
  id: string; source: string; tier: string; lane: "auto" | "approve";
  title: string; company: string; url: string;
  rate_min: number | ""; rate_max: number | ""; rate_type: string;
  posted_at: string; stack_tags: string; red_flags: string;
  fit_score: number | ""; score_why?: string;
  market: string; market_tier: MarketTier; market_confidence: Confidence;
  market_signal: string;
  contact_email: string; contact_source: string;
};

export type SourceReport = {
  source: string; tier: string; status: "ok" | "FAIL";
  raw: number; kept: number; comp: number; err?: string;
};

export async function harvestAll(concurrency = 6): Promise<{
  rows: Listing[];
  competitors: { source: string; title: string; url: string; posted_at: string; stack_tags: string }[];
  report: SourceReport[];
}> {
  const rows: Listing[] = [];
  const competitors: { source: string; title: string; url: string; posted_at: string; stack_tags: string }[] = [];
  const report: SourceReport[] = [];

  async function runOne(src: Source) {
    try {
      let raw: Raw[];
      if (src.type === "custom") raw = await src.fetch!();
      else if (src.type === "json") raw = src.map!(JSON.parse(await get(src.url!)));
      else raw = parseFeed(await get(src.url!, "application/rss+xml, application/xml, text/xml"))
        .map((i) => ({ ...i, rate_hint: i.description }));

      let kept = 0, comp = 0;
      for (const r of raw) {
        if (!r.title || !r.url) continue;
        const blob = `${r.title} ${r.description ?? ""}`;
        if (!relevant(blob)) continue;

        if (SEEKING_WORK.test(blob)) {
          competitors.push({
            source: src.name, title: r.title.slice(0, 160), url: r.url,
            posted_at: r.posted_at ?? "", stack_tags: tagsFor(blob),
          });
          comp++;
          continue;
        }

        const [rmin, rmax, rtype] = parseRate(r.rate_hint || blob);
        // Detect on the full blob, not just the title: descriptions carry the
        // currency symbols and city names that make detection high-confidence.
        const mk = marketOf(blob, src.name, r.url);
        // Only from the full body — the title alone rarely carries an address,
        // and this text is otherwise discarded after tagging.
        const ct = extractContact(blob);
        rows.push({
          contact_email: ct?.email ?? "", contact_source: ct ? src.name : "",
          market: mk.market, market_tier: mk.tier,
          market_confidence: mk.confidence, market_signal: mk.signal,
          id: "", source: src.name, tier: src.tier, lane: src.lane,
          title: r.title.slice(0, 160), company: (r.company ?? "").slice(0, 80), url: r.url,
          rate_min: rmin, rate_max: rmax, rate_type: rtype,
          posted_at: r.posted_at ?? "",
          stack_tags: tagsFor(blob), red_flags: flagsFor(blob), fit_score: "",
        });
        kept++;
      }
      report.push({ source: src.name, tier: src.tier, status: "ok", raw: raw.length, kept, comp });
    } catch (e) {
      report.push({
        source: src.name, tier: src.tier, status: "FAIL", raw: 0, kept: 0, comp: 0,
        err: String((e as Error).message).slice(0, 60),
      });
    }
  }

  const queue = [...SOURCES];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) await runOne(queue.shift()!);
  }));

  // Dedupe on normalised title+company; first (higher-tier) sighting wins.
  const seen = new Set<string>();
  const unique: Listing[] = [];
  for (const r of rows) {
    const key = createHash("sha1")
      .update(`${r.title.toLowerCase().replace(/\W+/g, "")}|${r.company.toLowerCase().replace(/\W+/g, "")}`)
      .digest("hex");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...r, id: key.slice(0, 12) });
  }

  return { rows: unique, competitors, report };
}
