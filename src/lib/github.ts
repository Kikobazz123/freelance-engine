/**
 * Read the owner's public repos and turn them into CV/proposal evidence.
 *
 * The profile is the single source of truth for every claim this system makes,
 * and it was assembled by hand from repos that existed on one day. New work then
 * silently fails to appear in any proposal. This keeps it current.
 *
 * Read-only, and unauthenticated by default — the public API is enough and needs
 * no token in the task environment. A GITHUB_TOKEN raises the rate limit from 60
 * to 5,000 requests/hour if one is configured.
 */

const API = "https://api.github.com";
import { IDENTITY } from "../config.js";

const OWNER = IDENTITY.githubUser;

export type Repo = {
  name: string;
  description: string | null;
  language: string | null;
  topics: string[];
  pushed_at: string;
  size: number;
  fork: boolean;
  archived: boolean;
  html_url: string;
  stargazers_count: number;
};

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "freelance-engine",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const t = process.env.GITHUB_TOKEN;
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

export async function listRepos(): Promise<Repo[]> {
  const out: Repo[] = [];
  for (let page = 1; page <= 4; page++) {
    const r = await fetch(`${API}/users/${OWNER}/repos?per_page=100&sort=pushed&page=${page}`, {
      headers: headers(),
    });
    if (!r.ok) throw new Error(`GitHub repos: HTTP ${r.status}`);
    const batch = (await r.json()) as Repo[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  // Forks are someone else's work and archived repos are not evidence of current
  // capability. Both would pad the profile without supporting a single claim.
  return out.filter((r) => !r.fork && !r.archived);
}

/**
 * README body, or null. Used to pull out concrete, citable numbers.
 *
 * 16 KB, not 2 KB: the first cut at 2 KB missed every metric in the corpus,
 * because the numbers worth citing live in a Verification or Architecture
 * section near the BOTTOM of a good README, not in the opening pitch.
 */
export async function readme(repo: string): Promise<string | null> {
  const r = await fetch(`${API}/repos/${OWNER}/${repo}/readme`, {
    headers: { ...headers(), Accept: "application/vnd.github.raw" },
  });
  if (!r.ok) return null;
  return (await r.text()).slice(0, 16000);
}

/**
 * Numbers a proposal can cite. Deliberately narrow: only patterns that are
 * checkable in the repo, never adjectives. "60 automated verification checks"
 * came from exactly this kind of line and is the strongest thing in the CV.
 */
export function extractMetrics(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\b\d+\s+(?:automated\s+)?(?:verification\s+)?checks?\b/gi,
    /\b\d+\s+(?:versioned\s+)?(?:REST\s+|API\s+)?routes?\b/gi,
    /\b\d+\s+(?:test|spec)s?\b/gi,
    /\b\d+-stage\b/gi,
    /\b\d+\s+(?:channels?|sources?|providers?|integrations?|feeds?)\b/gi,
    /\b\d{3,4}x\d{3,4}\b/g,
  ];
  for (const re of patterns) {
    for (const m of text.match(re) ?? []) out.add(m.trim());
  }
  return [...out].slice(0, 8);
}

export type RepoEvidence = {
  name: string;
  description: string;
  language: string;
  pushed_at: string;
  sizeKb: number;
  url: string;
  metrics: string[];
};

/**
 * Build the evidence set, newest first.
 *
 * READMEs are only fetched for repos big enough to plausibly contain shippable
 * work — a 5 KB repo is a scaffold, and fetching all of them burns the
 * unauthenticated rate limit for nothing.
 */
export async function buildEvidence(minSizeKb = 20): Promise<RepoEvidence[]> {
  const repos = await listRepos();
  const out: RepoEvidence[] = [];
  for (const r of repos) {
    const metrics = r.size >= minSizeKb ? extractMetrics((await readme(r.name)) ?? "") : [];
    out.push({
      name: r.name,
      description: r.description ?? "",
      language: r.language ?? "",
      pushed_at: r.pushed_at,
      sizeKb: r.size,
      url: r.html_url,
      metrics,
    });
  }
  return out.sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at));
}
