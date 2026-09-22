/**
 * Probe candidate feeds before adopting any of them.
 *
 * Reports, per candidate: HTTP status, item count, whether the payload parses,
 * and — the number that actually matters for Lane A — how many items carry a
 * contactable email address. A board with 300 listings and no published
 * addresses feeds the marketplace lane, where the free-tier budget is eight
 * bids a month. A board with 40 listings and emails feeds the engine.
 *
 *   node scripts/probe-candidates.mjs
 */

const UA = "Mozilla/5.0 (compatible; freelance-engine/0.1; personal job search)";
const TIMEOUT = 20_000;

/** Same shape the real extractor rejects: job-seeker mail, noreply, assets. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JUNK = /noreply|no-reply|donotreply|sentry|wixpress|example\.|\.png|\.jpg|\.webp|@sentry|@2x/i;

const CANDIDATES = [
  // --- direct-client sources: people who publish an address and want a reply
  ["HN-Freelancer-Thread", "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=30", "json"],
  ["Reddit-forhire", "https://www.reddit.com/r/forhire/new.rss?limit=100", "rss"],
  ["Reddit-jobbit", "https://www.reddit.com/r/jobbit/new.rss?limit=100", "rss"],
  ["Reddit-remotejs", "https://www.reddit.com/r/remotejs/new.rss?limit=50", "rss"],
  ["Reddit-hiring", "https://www.reddit.com/r/hiring/new.rss?limit=100", "rss"],

  // --- Europe / strong currency
  ["Arbeitnow", "https://www.arbeitnow.com/api/job-board-api", "json"],
  ["EuropeRemotely", "https://europeremotely.com/feed.xml", "rss"],
  ["Landing.jobs", "https://landing.jobs/feed", "rss"],
  ["NoDesk", "https://nodesk.co/remote-jobs/feed/", "rss"],
  ["Remote.co", "https://remote.co/remote-jobs/feed/", "rss"],
  ["Jobgether", "https://jobgether.com/feed", "rss"],

  // --- AI / automation niche, his actual stack
  ["AI-Jobs-net", "https://ai-jobs.net/feed/", "rss"],
  ["AIJobs-rss", "https://aijobs.net/feed/", "rss"],
  ["RemoteOK-llm", "https://remoteok.com/api?tags=machine-learning", "json"],
  ["RemoteOK-typescript", "https://remoteok.com/api?tags=typescript", "json"],
  ["RemoteOK-nocode", "https://remoteok.com/api?tags=nocode", "json"],
  ["RemoteOK-react", "https://remoteok.com/api?tags=react", "json"],

  // --- general remote boards not yet used
  ["WorkingNomads-API", "https://www.workingnomads.com/api/exposed_jobs/", "json"],
  ["WorkingNomads-RSS", "https://www.workingnomads.com/jobsrss?category=development", "rss"],
  ["TheMuse", "https://www.themuse.com/api/public/jobs?category=Software%20Engineer&page=1", "json"],
  ["Jobicy-all", "https://jobicy.com/api/v2/remote-jobs?count=50", "json"],
  ["Himalayas-ai", "https://himalayas.app/jobs/rss?categories=data-science", "rss"],
  ["WWR-Contract", "https://weworkremotely.com/categories/remote-contract-jobs.rss", "rss"],
  ["WWR-Design", "https://weworkremotely.com/categories/remote-design-jobs.rss", "rss"],
  ["Remotive-QA", "https://remotive.com/api/remote-jobs?category=qa&limit=60", "json"],
  ["Remotive-all", "https://remotive.com/api/remote-jobs?limit=200", "json"],

  // --- marketplaces (approve lane only)
  ["PeoplePerHour", "https://www.peopleperhour.com/freelance-jobs.rss", "rss"],
  ["Guru", "https://www.guru.com/rss/jobs/", "rss"],
  ["Freelancer-nextjs", "https://www.freelancer.com/rss.xml?keyword=next.js", "rss"],
  ["Freelancer-n8n", "https://www.freelancer.com/rss.xml?keyword=n8n", "rss"],
  ["Freelancer-scraping", "https://www.freelancer.com/rss.xml?keyword=web%20scraping", "rss"],
  ["Truelancer", "https://www.truelancer.com/rss/projects", "rss"],
];

async function probe(name, url, type) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: type === "json" ? "application/json" : "application/rss+xml, application/xml, text/xml, */*" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    const body = await r.text();
    if (!r.ok) return { name, url, status: `HTTP ${r.status}`, items: 0, emails: 0 };

    let items = 0;
    let sample = "";
    if (type === "json") {
      try {
        const j = JSON.parse(body);
        const arr = Array.isArray(j) ? j
          : j.jobs ?? j.data ?? j.results ?? j.hits ?? j.items ?? [];
        items = Array.isArray(arr) ? arr.length : 0;
        sample = JSON.stringify(arr?.[0] ?? {}).slice(0, 110);
      } catch {
        return { name, url, status: "NOT JSON", items: 0, emails: 0 };
      }
    } else {
      const m = body.match(/<item[\s>]|<entry[\s>]/g);
      items = m ? m.length : 0;
      if (!items && /<html/i.test(body)) {
        return { name, url, status: "HTML not feed", items: 0, emails: 0 };
      }
      sample = (body.match(/<title>([\s\S]*?)<\/title>/g)?.[1] ?? "").slice(0, 110);
    }

    const found = (body.match(EMAIL) ?? []).filter((e) => !JUNK.test(e));
    const emails = new Set(found).size;

    return { name, url, status: "ok", items, emails, sample };
  } catch (e) {
    return { name, url, status: String(e.message).slice(0, 38), items: 0, emails: 0 };
  } finally {
    clearTimeout(t);
  }
}

const results = [];
for (const [name, url, type] of CANDIDATES) {
  const r = await probe(name, url, type);
  results.push(r);
  const flag = r.status !== "ok" ? "DEAD" : r.items === 0 ? "EMPTY" : r.emails > 0 ? "EMAIL" : "ok";
  console.log(
    `${flag.padEnd(6)} ${r.name.padEnd(24)} items ${String(r.items).padStart(4)}  ` +
    `emails ${String(r.emails).padStart(3)}  ${r.status === "ok" ? "" : r.status}`,
  );
}

const live = results.filter((r) => r.status === "ok" && r.items > 0);
console.log(`\n${live.length}/${CANDIDATES.length} usable`);
console.log(`\nwith published emails (Lane A value):`);
for (const r of live.filter((x) => x.emails > 0).sort((a, b) => b.emails - a.emails)) {
  console.log(`  ${r.name.padEnd(24)} ${r.emails} addresses across ${r.items} items`);
}
