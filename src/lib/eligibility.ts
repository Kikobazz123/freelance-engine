/**
 * Can someone in Nigeria actually take this job?
 *
 * Most feeds publish the answer in a structured field — Remotive's
 * candidate_required_location, WeWorkRemotely's <region>, Jobicy's jobGeo,
 * Himalayas' locationRestrictions, WorkingNomads' and RemoteJobs.org's location
 * — and until 2026-09-22 the engine threw every one of them away. It scored
 * "USA Only" and "USA, Canada, Argentina, Mexico, Peru" roles as if he could
 * apply. Of 20 unfiltered Himalayas jobs, 18 were locked to other countries.
 *
 * The rule: an explicit list that names neither him nor something containing
 * him is a no. The one exception is Europe/UK, kept as a graded penalty rather
 * than a veto — UTC+1 overlaps European hours completely, and European
 * companies do contract EMEA-timezone freelancers, so it is the one locked
 * region where he has a real chance. "US-only" is a veto by the user's call.
 *
 * Unknown (no field, or text that names no region) is never penalised. Most
 * listings state nothing, and vetoing silence would gut the funnel.
 */

export type Eligibility = "open" | "eu_only" | "us_only" | "region_locked" | "unknown";

/** Text that includes a Nigeria-based remote worker. Checked first. */
const OPEN = new RegExp([
  /\bworldwide\b/, /\banywhere in the world\b/, /\banywhere\b(?!\s+in\b)/, /\bglobal(ly)?\b/,
  /\binternational(ly)?\b/, /\bemea\b/, /(?<!south\s)\bafrica\b/, /\bnigeria\b/,
  /\bwest africa\b/, /\ball countries\b/, /\bany country\b/,
  // Time-zone scoped roles he falls inside: Lagos is UTC+1, which is CET.
  /\bcet\b/, /\bcest\b/, /\bwat\b/, /\butc\s*\+\s*[0-2](?![0-9])/, /\bgmt\s*\+\s*[0-2](?![0-9])/,
].map((r) => r.source).join("|"), "i");

const EUROPE = new RegExp(
  "\\b(europe|european|eu|eea|uk|united kingdom|england|scotland|ireland|germany|france|" +
  "spain|portugal|netherlands|belgium|luxembourg|switzerland|austria|italy|poland|czechia|" +
  "czech republic|slovakia|hungary|romania|bulgaria|greece|croatia|slovenia|serbia|ukraine|" +
  "sweden|norway|denmark|finland|iceland|estonia|latvia|lithuania)\\b", "i");

const US = /\b(usa|u\.s\.a?\.?|united states|us|canada|north america|northern america|americas)\b/i;

/** Positive evidence of somewhere else. Silence is not evidence. */
const OTHER = new RegExp(
  "\\b(latam|latin america|south america|apac|asia|asia pacific|india|philippines|mexico|" +
  "brazil|brasil|argentina|colombia|peru|chile|uruguay|costa rica|nicaragua|guatemala|" +
  "australia|new zealand|japan|vietnam|singapore|malaysia|indonesia|thailand|pakistan|" +
  "bangladesh|sri lanka|china|korea|taiwan|south africa|kenya|egypt|morocco|turkey|israel|" +
  "uae|saudi|qatar)\\b", "i");

export function eligibility(loc: string | string[] | null | undefined): Eligibility {
  const text = (Array.isArray(loc) ? loc.join(", ") : loc ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "unknown";
  if (OPEN.test(text)) return "open";
  if (EUROPE.test(text)) return "eu_only";
  if (US.test(text)) return "us_only";
  if (OTHER.test(text)) return "region_locked";
  return "unknown";
}

/** The red flag an eligibility verdict adds, if any. */
export function eligibilityFlag(loc: string | string[] | null | undefined): string | null {
  const e = eligibility(loc);
  return e === "eu_only" || e === "us_only" || e === "region_locked" ? e : null;
}
