/**
 * Client-market detection and tiering.
 *
 * Goal: spend a tiny free bid budget only on clients who pay in strong currencies,
 * and never on the $3-8/hr work that dominates some marketplaces.
 *
 * This is about WHERE THE CLIENT IS, not where the freelancer is.
 *
 * Detection from free-text listings is genuinely imperfect, and the design reflects
 * that rather than hiding it:
 *   - a bare "$" is ambiguous (USD/CAD/AUD/SGD/NZD) and is NEVER used alone
 *   - "unknown" is a first-class result and is NEVER vetoed — only a positively
 *     identified Tier 3 market is
 *   - every detection records the signal that fired, so accuracy can be audited
 *     with scripts/geo-audit.ts instead of taken on faith
 */

export type MarketTier = 1 | 2 | 3 | 0; // 0 = unknown
export type Confidence = "high" | "low";
/**
 * `confidence` matters: a currency symbol or city name is evidence, whereas
 * "this feed is mostly US" is an assumption. Scoring must not treat them alike.
 */
export type MarketHit = {
  market: string; tier: MarketTier; signal: string; confidence: Confidence;
};

/** Strongest currencies and rates. */
const TIER1: Record<string, RegExp> = {
  US: /\b(united states|u\.?s\.?a\.?|\bUSA\b|new york|nyc|san francisco|bay area|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|EST|PST|CST|MST|EDT|PDT)\b/i,
  UK: /\b(united kingdom|england|scotland|wales|london|manchester|edinburgh|bristol|GBP|£|\bBST\b)\b/i,
  Switzerland: /\b(switzerland|swiss|zurich|geneva|z(ü|u)rich|\bCHF\b)\b/i,
  Norway: /\b(norway|norwegian|oslo|\bNOK\b)\b/i,
  Denmark: /\b(denmark|danish|copenhagen|k(ø|o)benhavn|\bDKK\b)\b/i,
  Sweden: /\b(sweden|swedish|stockholm|gothenburg|\bSEK\b)\b/i,
  Finland: /\b(finland|finnish|helsinki)\b/i,
  Iceland: /\b(iceland|reykjav(í|i)k)\b/i,
  Ireland: /\b(ireland|irish|dublin)\b/i,
  Germany: /\b(germany|german|deutschland|berlin|munich|m(ü|u)nchen|hamburg|frankfurt|cologne|k(ö|o)ln|stuttgart|\(m\/w\/d\)|\(m\/f\/d\))/i,
  Netherlands: /\b(netherlands|dutch|holland|amsterdam|rotterdam|utrecht|eindhoven|den haag)\b/i,
  Austria: /\b(austria|vienna|wien|\(m\/w\)|graz)\b/i,
  Belgium: /\b(belgium|brussels|antwerp|ghent)\b/i,
  Luxembourg: /\b(luxembourg)\b/i,
  Canada: /\b(canada|canadian|toronto|vancouver|montreal|ottawa|calgary|\bCAD\b|C\$)\b/i,
  Australia: /\b(australia|australian|sydney|melbourne|brisbane|perth|\bAUD\b|A\$|\bAEST\b)\b/i,
  NewZealand: /\b(new zealand|auckland|wellington|\bNZD\b)\b/i,
  Singapore: /\b(singapore|\bSGD\b)\b/i,
  UAE: /\b(united arab emirates|\bUAE\b|dubai|abu dhabi|\bAED\b)\b/i,
  Israel: /\b(israel|tel aviv|jerusalem|\bILS\b)\b/i,
};

/**
 * Standalone "US" / "U.S." — case-SENSITIVE on purpose. With /i this would match
 * "contact us", "join us", "tell us" and tag half the corpus American.
 */
const US_STRICT = /\b(US|U\.S\.|USA)\b/;

/** Good markets that pay meaningfully less than Tier 1 for engineering. */
const TIER2: Record<string, RegExp> = {
  Spain: /\b(spain|spanish|madrid|barcelona|valencia|sevilla|bilbao|m(á|a)laga)\b/i,
  France: /\b(france|french|paris|lyon|marseille|toulouse|bordeaux)\b/i,
  Italy: /\b(italy|italian|milan|milano|rome|roma|turin|torino)\b/i,
  Portugal: /\b(portugal|lisbon|lisboa|porto)\b/i,
  Japan: /\b(japan|tokyo|osaka|\bJPY\b)\b/i,
  SouthKorea: /\b(south korea|seoul|\bKRW\b)\b/i,
  Czechia: /\b(czech|czechia|prague|praha)\b/i,
  Poland: /\b(poland|polish|warsaw|krak(ó|o)w|wroc(ł|l)aw|\bPLN\b)\b/i,
  Estonia: /\b(estonia|tallinn)\b/i,
  Greece: /\b(greece|athens|thessaloniki)\b/i,
};

/** Rate-destroying markets. Vetoed — this is about who is paying, not who is working. */
const TIER3: Record<string, RegExp> = {
  India: /\b(india|indian|mumbai|bangalore|bengaluru|delhi|hyderabad|chennai|pune|kolkata|noida|gurgaon|ahmedabad|\bINR\b|₹|\brupees?\b|\blakh\b|\bcrore\b|\bIST\b)\b/i,
  Pakistan: /\b(pakistan|karachi|lahore|islamabad|rawalpindi|\bPKR\b)\b/i,
  Bangladesh: /\b(bangladesh|dhaka|chittagong|\bBDT\b)\b/i,
  Philippines: /\b(philippines|filipino|manila|cebu|davao|quezon city|\bPHP currency\b|₱)\b/i,
  Indonesia: /\b(indonesia|jakarta|surabaya|bandung|\bIDR\b)\b/i,
  Vietnam: /\b(vietnam|viet nam|hanoi|ho chi minh|saigon|\bVND\b)\b/i,
  Egypt: /\b(egypt|cairo|alexandria|\bEGP\b)\b/i,
  SriLanka: /\b(sri lanka|colombo|\bLKR\b)\b/i,
  Nepal: /\b(nepal|kathmandu|\bNPR\b)\b/i,
  Kenya: /\b(kenya|nairobi|\bKES\b)\b/i,
  Ghana: /\b(ghana|accra|\bGHS\b)\b/i,
  Nigeria: /\b(nigeria|nigerian|lagos|abuja|port harcourt|\bNGN\b|₦|\bnaira\b)\b/i,
  Morocco: /\b(morocco|casablanca|rabat|\bMAD\b)\b/i,
  Myanmar: /\b(myanmar|burma|yangon)\b/i,
  Cambodia: /\b(cambodia|phnom penh)\b/i,
};

/**
 * The euro is a strong signal of an EU market but names no country, so it maps to
 * a generic Tier 2 rather than guessing. A listing that also names a Tier 1 EU
 * country will have matched above and never reach this.
 */
const EURO = /(€|\bEUR\b|\beuros?\b)/i;

/** ccTLDs are high-confidence when present in the listing URL. */
const TLD: [RegExp, string, MarketTier][] = [
  [/\.co\.uk(\/|$)/i, "UK", 1], [/\.uk(\/|$)/i, "UK", 1],
  [/\.de(\/|$)/i, "Germany", 1], [/\.nl(\/|$)/i, "Netherlands", 1],
  [/\.ch(\/|$)/i, "Switzerland", 1], [/\.no(\/|$)/i, "Norway", 1],
  [/\.se(\/|$)/i, "Sweden", 1], [/\.dk(\/|$)/i, "Denmark", 1],
  [/\.fi(\/|$)/i, "Finland", 1], [/\.ie(\/|$)/i, "Ireland", 1],
  [/\.at(\/|$)/i, "Austria", 1], [/\.ca(\/|$)/i, "Canada", 1],
  [/\.com\.au(\/|$)/i, "Australia", 1], [/\.nz(\/|$)/i, "NewZealand", 1],
  [/\.sg(\/|$)/i, "Singapore", 1],
  [/\.es(\/|$)/i, "Spain", 2], [/\.fr(\/|$)/i, "France", 2],
  [/\.it(\/|$)/i, "Italy", 2], [/\.pt(\/|$)/i, "Portugal", 2],
  [/\.pl(\/|$)/i, "Poland", 2],
  [/\.in(\/|$)/i, "India", 3], [/\.pk(\/|$)/i, "Pakistan", 3],
  [/\.ng(\/|$)/i, "Nigeria", 3], [/\.ph(\/|$)/i, "Philippines", 3],
  [/\.id(\/|$)/i, "Indonesia", 3], [/\.bd(\/|$)/i, "Bangladesh", 3],
];

/**
 * Some sources are structurally one market and that beats any text guess.
 * Only asserted where it is actually true of the feed, not assumed.
 */
const SOURCE_MARKET: Record<string, [string, MarketTier]> = {
  "HN-WhoIsHiring": ["US", 1],   // overwhelmingly US/EU startups
  "WWR-All": ["US", 1],
  "WWR-FullStack": ["US", 1],
  "WWR-Programming": ["US", 1],
  "WWR-DevOps": ["US", 1],
  "WWR-Backend": ["US", 1],
  "Codeur": ["France", 2],       // French-language marketplace
};

/**
 * Detect the client's market.
 *
 * Two rules learned from auditing this against 982 real listings:
 *
 * 1. **Co-occurrence means ambiguous, not Tier 3.** "Oscilar.com | Sr/Staff Engineers
 *    | REMOTE (US/Canada)" was vetoed as India purely because the word appeared
 *    elsewhere in the post. When a Tier 3 and a Tier 1/2 signal both fire, the honest
 *    answer is unknown. Unknown stays eligible; a wrong veto costs a bid out of six.
 *
 * 2. **Feed-level inference is an assumption, not evidence.** Tagging every WWR and
 *    HN post "US" covered 39% of the corpus on my say-so. It is a reasonable prior,
 *    so it is kept — but marked `confidence: "low"` so scoring can weight it far
 *    below an actual currency symbol or city name.
 */
export function marketOf(text: string, source?: string, url?: string): MarketHit {
  const blob = `${text} ${url ?? ""}`;

  const findIn = (table: Record<string, RegExp>) => {
    for (const [name, re] of Object.entries(table)) {
      const m = blob.match(re);
      if (m) return { name, match: m[0].slice(0, 24) };
    }
    return null;
  };

  const t3 = findIn(TIER3);
  const t1 = findIn(TIER1)
    ?? (US_STRICT.test(blob) ? { name: "US", match: "US" } : null);
  const t2 = findIn(TIER2);

  const tldHit = url ? TLD.find(([re]) => re.test(url)) : undefined;
  const t3Tld = tldHit && tldHit[2] === 3 ? tldHit : undefined;

  // Rule 1: conflicting evidence -> unknown, never a veto.
  if ((t3 || t3Tld) && (t1 || t2)) {
    const a = t3 ? t3.name : t3Tld![1];
    const b = t1 ? t1.name : t2!.name;
    return {
      market: "unknown", tier: 0,
      signal: `ambiguous:${a}+${b}`, confidence: "low",
    };
  }

  if (t3) return { market: t3.name, tier: 3, signal: `text:${t3.match}`, confidence: "high" };
  if (t3Tld) return { market: t3Tld[1], tier: 3, signal: "tld", confidence: "high" };
  if (t1) return { market: t1.name, tier: 1, signal: `text:${t1.match}`, confidence: "high" };
  if (t2) return { market: t2.name, tier: 2, signal: `text:${t2.match}`, confidence: "high" };

  if (tldHit) return { market: tldHit[1], tier: tldHit[2], signal: "tld", confidence: "high" };

  if (EURO.test(blob)) {
    return { market: "EU", tier: 2, signal: "currency:EUR", confidence: "high" };
  }

  // Rule 2: feed-level prior, explicitly low confidence.
  if (source && SOURCE_MARKET[source]) {
    const [name, tier] = SOURCE_MARKET[source];
    return { market: name, tier, signal: "source-prior", confidence: "low" };
  }

  // Deliberately not guessing from a bare "$".
  return { market: "unknown", tier: 0, signal: "none", confidence: "low" };
}
