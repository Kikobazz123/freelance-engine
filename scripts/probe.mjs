/** Probe candidate feed URLs and report which are live + how many items they carry. */
const UA = "Mozilla/5.0 (compatible; freelance-engine/0.1; personal job search)";

const CANDIDATES = [
  // Remotive category API (each category is a distinct usable source)
  ["Remotive-DevOps", "https://remotive.com/api/remote-jobs?category=devops&limit=60"],
  ["Remotive-Data", "https://remotive.com/api/remote-jobs?category=data&limit=60"],
  ["Remotive-AllDev", "https://remotive.com/api/remote-jobs?limit=200"],
  // Jobicy variants
  ["Jobicy-Dev", "https://jobicy.com/api/v2/remote-jobs?count=50&industry=dev"],
  ["Jobicy-Data", "https://jobicy.com/api/v2/remote-jobs?count=50&industry=data-science"],
  ["Jobicy-All", "https://jobicy.com/api/v2/remote-jobs?count=50"],
  // WeWorkRemotely categories
  ["WWR-DevOps", "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss"],
  ["WWR-Backend", "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss"],
  ["WWR-Front", "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss"],
  ["WWR-All", "https://weworkremotely.com/remote-jobs.rss"],
  ["WWR-Contract", "https://weworkremotely.com/categories/remote-contract-jobs.rss"],
  // Working Nomads
  ["WorkingNomads-Dev", "https://www.workingnomads.com/jobsrss?category=development"],
  ["WorkingNomads2", "https://www.workingnomads.com/jobs.rss"],
  ["WorkingNomads3", "https://www.workingnomads.com/feed"],
  // Himalayas
  ["Himalayas-Eng", "https://himalayas.app/jobs/rss?categories=software-engineering"],
  ["Himalayas-API", "https://himalayas.app/jobs/api?limit=100"],
  // Others
  ["NoDesk", "https://nodesk.co/remote-jobs/feed/"],
  ["NoDesk2", "https://nodesk.co/feed.xml"],
  ["Arbeitnow", "https://arbeitnow.com/api/job-board-api"],
  ["Jobspresso-Tech", "https://jobspresso.co/?feed=job_feed"],
  ["Remote.io", "https://www.remote.io/rss/remote-jobs"],
  ["Remotewx", "https://remotewx.com/feed"],
  ["Skipthedrive", "https://www.skipthedrive.com/feed/"],
  ["VirtualVocations", "https://www.virtualvocations.com/jobs/rss"],
  ["Dailyremote", "https://dailyremote.com/rss"],
  ["Justremote", "https://justremote.co/remote-developer-jobs.rss"],
  ["Remoters", "https://remoters.net/feed/"],
  ["4dayweek", "https://4dayweek.io/rss"],
  ["Otta", "https://otta.com/jobs.rss"],
  ["Hnhiring", "https://hnhiring.com/rss"],
  ["Rubyonremote", "https://rubyonremote.com/feed"],
  ["Golangprojects", "https://www.golangprojects.com/rss.xml"],
  ["Startup-jobs", "https://startup.jobs/feed"],
  ["Devitjobs", "https://devitjobs.com/feed"],
  ["Aijobs-net2", "https://ai-jobs.net/rss/"],
  ["Aijobs-net3", "https://ai-jobs.net/index.xml"],
  ["Mlconf", "https://www.ml-jobs.net/feed"],
  ["Techjobsforgood", "https://techjobsforgood.com/feed"],
  ["Builtin", "https://builtin.com/jobs.rss"],
  ["Cryptojobslist", "https://cryptojobslist.com/feed"],
  ["Web3career", "https://web3.career/feed"],
  ["Nowhiteboard", "https://nowhiteboard.org/feed.xml"],
  ["Wfh.io", "https://www.wfh.io/jobs.rss"],
  ["Remoteok-tags", "https://remoteok.com/api?tags=ai"],
  ["Larajobs", "https://larajobs.com/feed"],
  ["Pyjobs", "https://pyjobs.com/feed"],
  ["Stackoverflow", "https://stackoverflow.com/jobs/feed"],
  ["Freelancer-rss2", "https://www.freelancer.com/rss.xml?keyword=automation"],
  ["Twago", "https://www.twago.com/rss"],
  ["Codeur", "https://www.codeur.com/projects.rss"],
  ["Malt", "https://www.malt.fr/rss"],
  ["Toptal-blog", "https://www.toptal.com/careers.rss"],
  ["Contra", "https://contra.com/rss"],
  ["Gun.io", "https://gun.io/feed/"],
  ["Braintrust", "https://www.usebraintrust.com/feed"],
  ["Hasjob", "https://hasjob.co/feed"],
  ["Remoteleaf", "https://remoteleaf.com/feed"],
  ["Nomadlist", "https://nomads.com/jobs.rss"],
  ["Pangian", "https://pangian.com/feed/"],
  ["Jobgether", "https://jobgether.com/feed"],
  ["Remoterocketship", "https://www.remoterocketship.com/feed"],
];

const probe = async ([name, url]) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) return { name, url, status: `HTTP ${r.status}`, n: 0 };
    const txt = await r.text();
    const ct = r.headers.get("content-type") || "";
    let n = 0, kind = "?";
    if (ct.includes("json") || txt.trimStart().startsWith("[") || txt.trimStart().startsWith("{")) {
      kind = "json";
      try {
        const d = JSON.parse(txt);
        const arr = Array.isArray(d) ? d : (d.jobs || d.data || d.results || d.items || []);
        n = Array.isArray(arr) ? arr.length : 0;
      } catch { n = 0; }
    } else {
      kind = "rss";
      n = (txt.match(/<(item|entry)\b/g) || []).length;
    }
    return { name, url, status: "ok", kind, n, bytes: txt.length };
  } catch (e) {
    return { name, url, status: String(e.message).slice(0, 28), n: 0 };
  } finally { clearTimeout(t); }
};

const q = [...CANDIDATES], out = [];

function report() {
  out.sort((a, b) => b.n - a.n);
  console.log("LIVE FEEDS (items > 0):");
  for (const r of out.filter((r) => r.n > 0)) {
    console.log(`  ${String(r.n).padStart(4)}  ${(r.kind || "").padEnd(4)} ${r.name.padEnd(22)} ${r.url}`);
  }
  console.log("\nDEAD:");
  console.log(out.filter((r) => r.n === 0).map((r) => `  ${r.name} (${r.status})`).join("\n"));
  console.log(`\nlive: ${out.filter((r) => r.n > 0).length} / ${out.length}`);
}

// Global deadline: a couple of hosts hold the socket open past the per-request abort.
const deadline = setTimeout(() => { report(); console.log("[global deadline hit]"); process.exit(0); }, 90000);

await Promise.all(Array.from({ length: 8 }, async () => {
  while (q.length) out.push(await probe(q.shift()));
}));
clearTimeout(deadline);
report();

// Hard exit: some hosts hold keep-alive sockets open and block Node from exiting.
process.exit(0);
