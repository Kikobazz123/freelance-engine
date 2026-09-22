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
import { eligibilityFlag } from "./eligibility.js";

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
  us_only: /\b(?:us|usa|u\.s\.)[- ]?only\b|\bonly\b[^.]{0,20}\b(?:us|usa)\b|\bmust be (?:located |based )?in the (?:us|usa|united states)\b|(?:\bus|\busa|\bu\.s\.)[- ]?based\b|\bus citizens? only\b|\bauthoriz(?:ed|ation) to work in the (?:us|united states)\b|\bw2\b|\bgreen card\b|\bremote\s*\(\s*(?:us\b|usa\b|u\.s\.)|\bus[- ]remote\b|\bremote[- ]us\b/i,
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

/**
 * How much posting text survives harvest.
 *
 * These were 700-1,500 characters, applied BEFORE the contact extractor ran.
 * Postings put "send your CV to jobs@..." at the end, so the address was being
 * thrown away by us, not missing from the feed: a page fetch of HN postings
 * found apply lines that sat just past the old 1,500-character cut. The same
 * cap bounds what is stored in listings.description for the letter writer.
 */
export const DESC_CAP = 6000;

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
  /** The feed's own statement of where applicants may be. See eligibility.ts. */
  location?: string;
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
      // WeWorkRemotely: "Anywhere in the World" / "USA Only" / "North America Only".
      location: tag("region"),
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
/** Add the feed's own eligibility verdict to the text-derived flags, without duplicates. */
export function withEligibility(flags: string, location?: string): string {
  const f = flags.split("|").filter(Boolean);
  const e = eligibilityFlag(location);
  if (e && !f.includes(e)) f.push(e);
  return f.join("|");
}

/** Anything that says the job can be done from somewhere else. */
export const REMOTE_SIGNAL =
  /\bremote\b|\banywhere\b|\bworldwide\b|\bdistributed\b|\bwork from home\b|\bwfh\b/i;

/** Boards that list nothing but remote work — "on-site" there means an offsite, not an office. */
const REMOTE_ONLY_BOARD = /^(WWR|Remotive|RemoteOK|Jobicy|Himalayas|WorkingNomads|Jobspresso|Arbeitnow)/;

/**
 * Red flags, plus one derived flag.
 *
 * `onsite` alone is too broad to act on: it matches "hybrid", "relocation
 * assistance" and "REMOTE or ONSITE (SF)". But "Strobe Power | Site Reliability
 * Engineer | ONSITE (SF)" scored 67 and got a letter written, for an office
 * job on another continent. `onsite_only` is raised only when the
 * posting says on-site, says remote nowhere, and is not from a remote-only
 * board. That one is a hard veto; plain `onsite` stays a graded penalty.
 */
export const flagsFor = (t: string, source = "", title = "") => {
  const flags = Object.entries(RED_FLAGS).filter(([, re]) => re.test(t)).map(([k]) => k);
  if (REMOTE_ONLY_BOARD.test(source)) return flags.join("|");
  /*
   * Trust the title first. On HN it is the structured location field
   * ("Company | Role | ONSITE (SF) | ..."), while descriptions use "remote" in
   * unrelated senses — Strobe Power's mentioned it somewhere in 2,300 characters
   * and so escaped the body-only rule while its title said ONSITE.
   */
  const titleOffice = /\bon[- ]?site\b|\bin[- ]office\b|\bin[- ]person\b/i.test(title) && !REMOTE_SIGNAL.test(title);
  const bodyOffice = flags.includes("onsite") && !REMOTE_SIGNAL.test(t);
  if (titleOffice || bodyOffice) flags.push("onsite_only");
  return flags.join("|");
};
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
      description: `${j.title} ${strip(j.description).slice(0, DESC_CAP)} ${j.salary ?? ""}`,
      posted_at: j.publication_date, rate_hint: j.salary ?? "",
      location: j.candidate_required_location ?? "",
    })) },

  ...["dev", "data-science", "business", "marketing"].map((ind): Source => ({
    name: `Jobicy-${ind}`, tier: "C", lane: "auto", type: "json",
    url: `https://jobicy.com/api/v2/remote-jobs?count=50&industry=${ind}`,
    map: (d) => (d.jobs ?? []).map((j: any) => ({
      title: j.jobTitle, company: j.companyName, url: j.url,
      description: `${j.jobTitle} ${strip(j.jobExcerpt)} ${(j.jobIndustry ?? []).join(" ")}`,
      posted_at: j.pubDate,
      location: j.jobGeo ?? "",
      rate_hint: j.annualSalaryMin ? `$${j.annualSalaryMin}-$${j.annualSalaryMax}` : "",
    })),
  })),

  // typescript/react added 2026-09-22 after probing: 7 and 6 published
  // addresses per ~100 items, the richest email yield of any feed tested.
  ...["ai", "automation", "python", "typescript", "react", "machine-learning"].map((tag): Source => ({
    name: `RemoteOK-${tag}`, tier: "D", lane: "auto", type: "json",
    url: `https://remoteok.com/api?tags=${tag}`,
    map: (d) => (Array.isArray(d) ? d.slice(1) : []).map((j: any) => ({
      title: j.position ?? j.title, company: j.company, url: j.url ?? j.apply_url,
      description: `${j.position ?? ""} ${(j.tags ?? []).join(" ")} ${strip(j.description).slice(0, DESC_CAP)}`,
      posted_at: j.date,
      location: j.location ?? "",
      rate_hint: j.salary_min ? `$${j.salary_min}-$${j.salary_max}` : "",
    })),
  })),

  ...["devops", "data", "software-dev"].map((cat): Source => ({
    name: `Remotive-${cat}`, tier: "C", lane: "auto", type: "json",
    url: `https://remotive.com/api/remote-jobs?category=${cat}&limit=60`,
    map: (d) => (d.jobs ?? []).map((j: any) => ({
      title: j.title, company: j.company_name, url: j.url,
      description: `${j.title} ${strip(j.description).slice(0, DESC_CAP)} ${j.salary ?? ""}`,
      posted_at: j.publication_date, rate_hint: j.salary ?? "",
      location: j.candidate_required_location ?? "",
    })),
  })),

  /*
   * Himalayas, asked the right question. The unfiltered feed was 18 of 20 jobs
   * locked to the US, Canada, India or Mexico. The search API's country filter
   * returns only roles open to applicants in Nigeria (worldwide ones included),
   * so eligibility is decided at the source instead of guessed from text.
   * Max 20 per query; one query per core skill.
   */
  ...["python", "typescript", "automation", "ai engineer", "backend", "full stack"].map((q): Source => ({
    name: `Himalayas-NG-${q.replace(/\s+/g, "-")}`, tier: "C", lane: "auto", type: "json",
    url: `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(q)}&country=NG&sort=recent`,
    map: (d) => (d.jobs ?? []).map((j: any) => ({
      title: j.title, company: j.companyName ?? j.company, url: j.applicationLink ?? j.guid,
      description: `${j.title} ${strip(j.description ?? j.excerpt).slice(0, DESC_CAP)}`,
      posted_at: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : "",
      rate_hint: j.minSalary ? `$${j.minSalary}-$${j.maxSalary}` : "",
      location: (j.locationRestrictions ?? []).length ? j.locationRestrictions.join(", ") : "Worldwide",
    })),
  })),

  // Jobicy's own "Anywhere" scope: worldwide by definition.
  ...["dev", "data-science"].map((ind): Source => ({
    name: `Jobicy-anywhere-${ind}`, tier: "C", lane: "auto", type: "json",
    url: `https://jobicy.com/api/v2/remote-jobs?count=100&geo=anywhere&industry=${ind}`,
    map: (d) => (d.jobs ?? []).map((j: any) => ({
      title: j.jobTitle, company: j.companyName, url: j.url,
      description: `${j.jobTitle} ${strip(j.jobDescription ?? j.jobExcerpt).slice(0, DESC_CAP)}`,
      posted_at: j.pubDate, location: j.jobGeo ?? "Anywhere",
      rate_hint: j.annualSalaryMin ? `$${j.annualSalaryMin}-$${j.annualSalaryMax}` : "",
    })),
  })),

  // RemoteJobs.org: free, no key; "contract" is the freelance-shaped slice.
  ...["", "contract"].map((type): Source => ({
    name: `RemoteJobs-${type || "programming"}`, tier: "C", lane: "auto", type: "json",
    url: `https://remotejobs.org/api/v1/jobs?category=programming&limit=50${type ? `&type=${type}` : ""}`,
    map: (d) => (d.jobs ?? d.data ?? []).map((j: any) => ({
      title: j.title, company: j.company?.name ?? "", url: j.apply_url ?? j.url,
      description: `${j.title} ${j.salary_text ?? ""} ${strip(j.description).slice(0, DESC_CAP)}`,
      posted_at: j.posted_at, location: j.location ?? "",
      rate_hint: j.salary_text ?? "",
    })),
  })),


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
      /*
       * Top-level comments only. A reply is someone answering a posting —
       * usually a candidate ("Interested in the Full Stack AI Engineer role. I
       * build agents...") — not an employer. Replies were harvested for weeks:
       * 55 of 306 HN listings, one of them ranked 90. None carried an address,
       * but one that did would have been emailed as if it were a hiring
       * manager. 141 of 400 comments in the September thread are replies.
       */
      return (c.hits ?? [])
        .filter((h: any) => h.comment_text && String(h.parent_id) === String(story.objectID))
        .map((h: any) => {
        const txt = strip(h.comment_text);
        return {
          title: txt.slice(0, 130),
          company: (txt.split("|")[0] ?? "HN").trim().slice(0, 60),
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          description: txt.slice(0, DESC_CAP),
          posted_at: h.created_at,
          rate_hint: txt,
        };
      });
    } },

  // --- added 2026-09-22; each passed scripts/probe-candidates.mjs first ---

  { name: "WorkingNomads", tier: "C", lane: "auto", type: "json",
    url: "https://www.workingnomads.com/api/exposed_jobs/",
    map: (d) => (Array.isArray(d) ? d : []).map((j: any) => ({
      title: j.title, company: j.company_name, url: j.url,
      description: `${j.title} ${j.location ?? ""} ${j.tags ?? ""} ${strip(j.description).slice(0, DESC_CAP)}`,
      posted_at: j.pub_date, rate_hint: "",
      location: j.location ?? "",
    })) },

  // Mostly on-site German roles; only the remote ones are any use from Nigeria.
  { name: "Arbeitnow", tier: "C", lane: "auto", type: "json",
    url: "https://www.arbeitnow.com/api/job-board-api",
    map: (d) => (d.data ?? []).filter((j: any) => j.remote === true).map((j: any) => ({
      title: j.title, company: j.company_name, url: j.url,
      description: `${j.title} remote ${j.location ?? ""} ${(j.tags ?? []).join(" ")} ${strip(j.description).slice(0, DESC_CAP)}`,
      posted_at: j.created_at ? new Date(j.created_at * 1000).toISOString() : "",
      location: `${j.location ?? ""}, Germany`,
      rate_hint: "",
    })) },

  /*
   * r/forhire, [Hiring] posts only. The other ~85% are people selling their own
   * services — competitors, not clients. Direct clients (tier F) with no platform
   * fee; the rate floor and market tiering filter out the $5/hr posts. One
   * request per harvest keeps well under Reddit's limits (the probe hit 429s
   * only when hammering several subreddits back to back).
   */
  { name: "Reddit-forhire", tier: "F", lane: "auto", type: "custom",
    fetch: async () =>
      parseFeed(await get("https://www.reddit.com/r/forhire/new.rss?limit=100",
        "application/atom+xml, application/xml, text/xml"))
        .filter((i) => /^\s*\[hiring\]/i.test(i.title))
        .map((i) => ({ ...i, title: i.title.replace(/^\s*\[hiring\]\s*/i, ""), rate_hint: i.description })) },

  /*
   * Remotiko: a board built for applicants in Africa and other under-served
   * regions, pulling straight from company ATS systems (1,144 jobs on
   * 2026-09-22). It has no advertised feed, but runs WordPress Job Manager,
   * whose standard REST endpoint is public and robots.txt allows it. Applies are
   * ATS links, not emails — these feed the apply-kit lane. Newest 300 per run.
   * The structured _job_location goes through eligibility like every other feed:
   * it includes Philippines-only and US-only roles alongside worldwide ones.
   */
  { name: "Remotiko", tier: "C", lane: "auto", type: "custom",
    fetch: async () => {
      const out: Raw[] = [];
      for (let page = 1; page <= 3; page++) {
        let items: any[];
        try {
          items = JSON.parse(await get(
            `https://remotiko.com/wp-json/wp/v2/job-listings?per_page=100&page=${page}`));
        } catch { break; }
        if (!Array.isArray(items) || !items.length) break;
        for (const j of items) {
          if (j.meta?._filled === "1" || j.meta?._filled === 1) continue;
          const loc = j.meta?._job_location;
          out.push({
            title: strip(j.title?.rendered ?? ""),
            company: j.meta?._company_name ?? "",
            url: j.meta?._application && /^https?:/.test(j.meta._application) ? j.meta._application : j.link,
            description: strip(j.content?.rendered ?? "").slice(0, DESC_CAP),
            posted_at: j.date_gmt ? `${j.date_gmt}Z` : j.date,
            rate_hint: j.meta?._job_salary ? `${j.meta._job_salary} ${j.meta._job_salary_unit ?? ""}` : "",
            location: typeof loc === "string" && loc !== "Array" ? loc : "",
          });
        }
      }
      return out;
    } },

  // --- RSS (all verified live) ---
  // Removed 2026-09-22: Larajobs (PHP only), Golangprojects (Go only) and
  // Hasjob (India-based, a Tier 3 market). None could produce a match he can
  // take; they only added rows for the scorer to reject.
  ...[
    ["WWR-All", "https://weworkremotely.com/remote-jobs.rss", "C"],
    ["WWR-FullStack", "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss", "C"],
    ["WWR-Programming", "https://weworkremotely.com/categories/remote-programming-jobs.rss", "C"],
    ["WWR-DevOps", "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss", "C"],
    ["WWR-Backend", "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss", "C"],
    ["Jobspresso", "https://jobspresso.co/?feed=job_feed", "C"],
    ["PythonJobs", "https://www.python.org/jobs/feed/rss/", "C"],
    ["Cryptocurrency-Jobs", "https://cryptocurrencyjobs.co/index.xml", "D"],
  ].map(([name, url, tier]): Source => ({
    name, tier, lane: "auto", type: "rss", url,
  })),

  { name: "Gun.io", tier: "B", lane: "approve", type: "rss", url: "https://gun.io/feed/" },

  // Marketplaces. lane:"approve" is load-bearing — nothing here is ever
  // auto-submitted, because that is exactly what gets accounts permanently banned.
  ...["automation", "ai agent", "python", "api integration", "chatbot",
      "n8n", "web scraping", "next.js"].map((kw): Source => ({
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
  description?: string;
  location?: string;
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
          description: strip(r.description ?? "").slice(0, 4000),
          market: mk.market, market_tier: mk.tier,
          market_confidence: mk.confidence, market_signal: mk.signal,
          id: "", source: src.name, tier: src.tier, lane: src.lane,
          title: r.title.slice(0, 160), company: (r.company ?? "").slice(0, 80), url: r.url,
          rate_min: rmin, rate_max: rmax, rate_type: rtype,
          posted_at: r.posted_at ?? "",
          stack_tags: tagsFor(blob),
          red_flags: withEligibility(flagsFor(blob, src.name, r.title), r.location),
          location: (r.location ?? "").slice(0, 300),
          fit_score: "",
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
