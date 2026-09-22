/**
 * Deterministic fit scoring, 0-100.
 *
 * Runs before any LLM call so the expensive per-listing tailoring only ever sees
 * the top slice. Same reasoning as BrightPath: the model extracts, code decides.
 * A score computed in a prompt cannot be diffed, reviewed or reproduced.
 */

export type Scorable = {
  title: string;
  tier: string;
  stack_tags: string;   // pipe-joined
  red_flags: string;    // pipe-joined
  rate_min: number | "" | null;
  rate_type: string | null;
  posted_at: string | null;
  market_tier?: 0 | 1 | 2 | 3 | null;
  market_confidence?: "high" | "low" | null;
  /** From eligibility.ts: "open" means the feed says he may apply. */
  eligibility?: string | null;
  /** Harvest source name. Decides whether the title is a real job title. */
  source?: string | null;
};

/**
 * On a structured job board the title IS a job title, so it must name something
 * technical. "BetterHelp: Licensed Clinical Marriage and Family Therapist"
 * ranked 88 on the stack words in BetterHelp's company blurb; the denylist in
 * roleMismatch() had no entry for therapist, and never will for every job.
 * Requiring a positive signal cannot be outrun that way.
 *
 * Free-text sources are exempt: an HN or Reddit "title" is the opening of a
 * post, and a marketplace title is a client's one-line brief ("Automate Harvest
 * invoice creation"), so a missing role noun there means nothing.
 */
const FREE_TEXT_SOURCE = /^(HN-|Reddit-|Freelancer-|Codeur|Gun\.io)/;
const TECHNICAL_TITLE =
  /\b(engineer\w*|developer\w*|programmer|swe|software|full[- ]?stack|back[- ]?end|front[- ]?end|devops|sre|architect|cto|machine learning|ml|ai|llm|automat\w*|data|integrations?|python|typescript|javascript|node|react|api|technical|tech|coder|web|platform|cloud|infrastructure|scrap\w*|chatbot|agents?|workflow|n8n|zapier)\b/i;

export function notTechnical(title: string, source?: string | null): boolean {
  if (source && FREE_TEXT_SOURCE.test(source)) return false;
  return !TECHNICAL_TITLE.test(title);
}

/**
 * Client market weighting.
 *
 * Confidence-split on purpose. A currency symbol or city name is evidence and earns
 * the full boost; "this feed is mostly US" is a prior covering ~39% of the corpus on
 * an assumption, and paying it the same would let a guess outrank a fact.
 *
 * Tier 3 is a hard veto: those markets routinely post $3-8/hr, which is below the
 * floor by a wide margin. Unknown is never penalised - 42% of listings state no
 * location, and vetoing those would gut the funnel.
 */
const MARKET_BONUS: Record<string, number> = {
  "1:high": 18, "1:low": 8,
  "2:high": 8,  "2:low": 4,
  // Tier 3 deliberately absent — it is an early-return veto, not a penalty.
  "0:high": 0, "0:low": 0,
};

// Weighted against demonstrable repo evidence, not aspiration.
const STACK_WEIGHTS: Record<string, number> = {
  automation: 14, agents: 14, n8n: 10, zapier: 8,
  claude: 12, openai: 10, langchain: 8, rag: 8,
  typescript: 10, python: 10, api: 8, scraping: 8,
  postgres: 6, react: 5, javascript: 5, aws: 3,
};

// F (direct client) ranks highest: no platform fee, no bid competition, and no
// review count to lose on — which matters a great deal from a cold profile.
const TIER_BONUS: Record<string, number> = { F: 12, A: 8, D: 6, C: 3, B: 0 };

// The wedge: clients whose no-code automation hit its ceiling. They have already
// felt the pain, so there is no rate resistance and no need to justify engineering.
const RESCUE_SIGNALS = [
  /\bn8n\b/i, /\bzapier\b/i, /\bmake\.com\b/i, /\bairtable\b/i,
  /\bbroke?n?\b.{0,30}\bautomation\b/i, /\bscal(e|ing)\b.{0,30}\bautomation\b/i,
  /\bmigrat(e|ing|ion)\b/i, /\breplace\b.{0,25}\b(zapier|make|n8n)\b/i,
];

const SENIORITY_PENALTY: [RegExp, number][] = [
  [/\b(staff|principal|director|head of|vp|chief)\b/i, -18],
  [/\b(10|12|15)\+?\s*years\b/i, -15],
  [/\b(8|9)\+?\s*years\b/i, -8],
  [/\bintern(ship)?\b/i, -12],
  // He has 1-3 years. These are ranking nudges, not vetoes: a Senior role
  // that fits the stack is still worth sending, just after the ones he fits.
  [/\blead\b/i, -10],
  [/\bsenior\b|\bsr\.?\s/i, -6],
];

/*
 * Title fit — the job title as the main signal.
 *
 * Stack tags are read from the whole posting, company blurb included, so nearly
 * every listing at an AI company maxed the +45 stack bonus. Twelve jobs tied at
 * exactly 100: "AI agent engineer" alongside "Data & Insights Technical
 * Consultant", "Automation & AI Adoption Teaching Expert" and "Developer
 * Advocate". The title says what the job IS; the description says what the
 * company does. Title fit is now worth more than the description stack.
 */
const CORE_ROLE_TITLE = new RegExp(
  "\\b(ai|ml|llm|genai|agentic|agents?|automation|integrations?|workflow|chatbot)\\b[^|,;()]{0,30}" +
  "\\b(engineer|developer|specialist|builder|architect)\\b" +
  "|\\b(forward[- ]deployed|solutions engineer|automation engineer|integrations? engineer|" +
  "ai engineer|llm engineer|agents? engineer)\\b", "i");
const STACK_ROLE_TITLE = /\b(python|typescript|javascript|node(\.js)?|full[- ]?stack|back[- ]?end|api|platform)\b/i;
const GENERIC_ROLE_TITLE = /\b(engineer|developer|programmer|swe)\b/i;
const ADJACENT_TITLE =
  /\b(consultant|advocate|evangelist|teach\w*|trainer|instructor|analyst|qa|quality assurance|testing|tester|sdet|application security|security engineer|product manager|manager|writer|researcher|scientist|adoption)\b/i;
const CONTRACT_TITLE = /\b(contract(or)?|freelancer?|part[- ]time|hourly)\b/i;
const TITLE_STACK = /\b(python|typescript|javascript|node(\.js)?|react|next\.?js|fastapi|postgres|llm|openai|claude|agents?|automation|api)\b/gi;

/** Points for what the title says the job is. Exported for tests. */
export function titleFit(title: string): { points: number; why: string[] } {
  const why: string[] = [];
  let p = 0;
  if (CORE_ROLE_TITLE.test(title)) { p += 18; why.push("core-role+18"); }
  else if (STACK_ROLE_TITLE.test(title)) { p += 10; why.push("stack-role+10"); }
  else if (GENERIC_ROLE_TITLE.test(title)) { p += 4; why.push("engineer+4"); }
  if (ADJACENT_TITLE.test(title)) { p -= 15; why.push("adjacent-role-15"); }
  const named = new Set((title.match(TITLE_STACK) ?? []).map((t) => t.toLowerCase()));
  if (named.size) { const b = Math.min(named.size * 3, 9); p += b; why.push(`title-stack+${b}`); }
  return { points: p, why };
}

/**
 * Hard vetoes — an early return, never a large negative number.
 *
 * Subtracting 100 looked equivalent and was not: a listing scoring 116 on stack,
 * rate and freshness came out at 16 after its "veto", which only reaches zero
 * because of the final clamp. Raise any weight and fraud starts scoring above the
 * skip line. A veto has to be a branch, not arithmetic.
 */
/*
 * us_only joined the vetoes on 2026-09-22, at the user's decision. It was a -35
 * penalty, which still let "100% remote; US-only" roles through at 86: those
 * require US residency or work authorisation, which a Nigeria-based applicant
 * cannot meet, so every such letter was a guaranteed no.
 */
// not_a_posting: a harvested item that is not a job at all (an HN reply).
const HARD_VETO_FLAGS = [
  "abuse", "unpaid", "equity_only", "clearance", "onsite_only", "us_only", "region_locked",
  "not_a_posting",
] as const;

/**
 * The job is not an engineering job.
 *
 * Stack tags come from the whole description, so a Product Designer role at an
 * AI company collects "agents", "claude" and "typescript" from the company
 * blurb and scores 76. "Tines: Deal Desk Analyst" reached 100. Harmless while
 * almost none of these had an email; once discovery finds addresses, each one
 * becomes a letter to a hiring manager for a job he cannot do.
 *
 * Vetoed only when the title names a non-engineering role AND no engineering
 * one, because HN posts list several roles in one title ("2 Full Stack AI
 * Engineers, 1 GTM") and those must survive.
 */
const NON_ENGINEERING_ROLE =
  /\b(designer|customer success|account (executive|manager)|sales|deal desk|recruit(er|ing)|talent acquisition|marketing (manager|lead|specialist)|content (writer|marketer)|copywriter|accountant|bookkeep\w*|paralegal|legal counsel|nurse|support (agent|specialist|representative)|soc analyst|security operations analyst|operations lead|office manager|executive assistant|business development|hr (manager|generalist))\b/i;
const ENGINEERING_ROLE =
  /\b(engineer\w*|developer\w*|programmer|swe|software|full[- ]?stack|back[- ]?end|front[- ]?end|devops|sre|architect|cto|machine learning|ml|data (engineer|scientist)|automation)\b/i;

/**
 * The job is advertised in a language he does not work in.
 *
 * "Pessoa Engenheira de Dados Sênior" reached an apply kit: Himalayas marked it
 * worldwide, and the stack tags were right, but a Portuguese title means a
 * Portuguese-speaking team. Title words only, and only role nouns — a German
 * posting written in English still says "(m/w/d)", and that one is fine.
 */
const FOREIGN_LANGUAGE_TITLE =
  /\b(pessoa|engenheir[oa]s?|desenvolvedor[a]?|analista de|vaga|desarrollador[a]?|ingenier[oa]|programador[a]?|entwickler(in)?|ingénieur|développeur|développeuse|sviluppatore|ontwikkelaar)\b/i;

export function foreignLanguage(title: string): boolean {
  return FOREIGN_LANGUAGE_TITLE.test(title);
}

export function roleMismatch(title: string): boolean {
  return NON_ENGINEERING_ROLE.test(title) && !ENGINEERING_ROLE.test(title);
}

/**
 * The title names a core stack he does not work in.
 *
 * "Tech Lead Full-Stack Rails Engineer" scored 66 on React and Claude mentions
 * from the company blurb, and "Senior .NET Full-stack Developer" scored 78. The
 * letter can only answer those with an honest gap, which is a wasted send. A
 * penalty, not a veto: a title that also names his stack ("Python/Go Backend")
 * is left alone, since the Python half is real.
 */
// ".NET" and "C#" sit outside the \b group on purpose: \b needs a word character
// on one side, so it can never match before "." or after "#". Inside the group
// both terms silently never fired.
const FOREIGN_STACK_TITLE =
  /\b(rails|ruby|php|laravel|java(?!script)|golang|go developer|rust|ios|swift|android|kotlin|salesforce|sap|drupal|wordpress|shopify|unity|unreal|embedded|firmware|fpga)\b|(?<![\w.])\.net\b|\bc#(?!\w)/i;
const OWN_STACK_TITLE = /\b(python|typescript|javascript|node|react|next\.?js|full[- ]?stack ai|ai|llm|automation|agents?)\b/i;

export function foreignStack(title: string): boolean {
  return FOREIGN_STACK_TITLE.test(title) && !OWN_STACK_TITLE.test(title);
}

// Graded penalties only. Absolute disqualifiers are in HARD_VETO_FLAGS above.
const RED_FLAG_PENALTY: Record<string, number> = {
  eu_only: -20, onsite: -30,
};

function daysOld(s: string | null): number {
  if (!s) return 99;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 99 : Math.max(0, (Date.now() - t) / 86_400_000);
}

/**
 * `score` is the 0-100 fit used as the bar (>= 65 qualifies). `raw` is the same
 * sum before clamping, stored as rank_score and used for ORDERING — so two jobs
 * that both clear 100 are still ranked against each other instead of tying.
 */
export function score(row: Scorable, rateFloor = 35): { score: number; why: string; raw: number } {
  // --- vetoes first, before any points can be earned ---
  const flags = (row.red_flags || "").split("|").filter(Boolean);
  for (const f of HARD_VETO_FLAGS) {
    if (flags.includes(f)) return { score: 0, why: `VETO:${f}`, raw: 0 };
  }
  if (row.market_tier === 3) return { score: 0, why: "VETO:market-tier3", raw: 0 };
  if (roleMismatch(row.title)) return { score: 0, why: "VETO:not-engineering", raw: 0 };
  if (notTechnical(row.title, row.source)) return { score: 0, why: "VETO:not-technical", raw: 0 };
  if (foreignLanguage(row.title)) return { score: 0, why: "VETO:foreign-language", raw: 0 };

  const why: string[] = [];
  let s = 30;

  const tags = (row.stack_tags || "").split("|").filter(Boolean);
  // Half weight: these come from the whole posting, company blurb included, and
  // at full weight they swamped every other signal. See titleFit().
  const stack = Math.round(Math.min(tags.reduce((a, t) => a + (STACK_WEIGHTS[t] ?? 0), 0), 45) / 2);
  if (stack) { s += stack; why.push(`stack+${stack}(${tags.slice(0, 4).join(",")})`); }

  const tf = titleFit(row.title);
  s += tf.points; why.push(...tf.why);

  const tb = TIER_BONUS[row.tier] ?? 0;
  if (tb) { s += tb; why.push(`tier${row.tier}+${tb}`); }

  const blob = `${row.title} ${row.stack_tags}`;
  if (RESCUE_SIGNALS.some((re) => re.test(blob))) { s += 12; why.push("rescue+12"); }

  // His goal is freelance/contract work at $20/hr+, so say-so beats inference.
  if (CONTRACT_TITLE.test(row.title) || row.rate_type === "hourly") { s += 8; why.push("contract+8"); }

  // The feed says outright that he may apply — better odds than silence.
  if (row.eligibility === "open") { s += 8; why.push("open-to-you+8"); }

  const rmin = Number(row.rate_min) || 0;
  if (row.rate_type === "hourly" && rmin) {
    if (rmin >= 80) { s += 18; why.push("rate80+18"); }
    else if (rmin >= 50) { s += 12; why.push("rate50+12"); }
    else if (rmin >= rateFloor) { s += 5; why.push(`rate${rateFloor}+5`); }
    else { s -= 25; why.push("below-floor-25"); }
  } else if (row.rate_type === "annual" && rmin >= 90_000) {
    s += 10; why.push("salary+10");
  }

  // Freshness is the biggest controllable lever: on marketplaces the first few
  // proposals capture most of the client's attention.
  const d = daysOld(row.posted_at);
  if (d <= 1) { s += 15; why.push("today+15"); }
  else if (d <= 3) { s += 9; why.push("fresh+9"); }
  else if (d <= 7) { s += 4; why.push("week+4"); }
  else if (d > 30 && d < 99) { s -= 12; why.push("stale-12"); }

  for (const [re, p] of SENIORITY_PENALTY) {
    if (re.test(row.title)) { s += p; why.push(`seniority${p}`); break; }
  }

  if (foreignStack(row.title)) { s -= 30; why.push("foreign-stack-30"); }

  const mt = row.market_tier ?? 0;
  const mc = row.market_confidence ?? "low";
  const mb = MARKET_BONUS[`${mt}:${mc}`] ?? 0;
  if (mb) { s += mb; why.push(`market${mt}${mc === "low" ? "~" : ""}${mb > 0 ? "+" : ""}${mb}`); }

  for (const f of flags) {
    const p = RED_FLAG_PENALTY[f] ?? 0;
    if (p) { s += p; why.push(`${f}${p}`); }
  }

  return { score: Math.max(0, Math.min(100, Math.round(s))), why: why.join(" "), raw: Math.round(s) };
}
