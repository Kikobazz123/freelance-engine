/**
 * Post-generation claim validation.
 *
 * A system prompt is guidance, not a guarantee. Two real fabrications appeared in
 * the first Lane A dry run, both lifted from the *posting* rather than the profile:
 *
 *   "My stack matches your requirements: React, TypeScript, Python, FastAPI,
 *    and LangChain"          <- LangChain is not in the profile
 *   "I am remote and available for full-time work in NYC"
 *                            <- he is in Nigeria
 *
 * Either one collapses on the first call, and the second ends a conversation
 * before it starts. So generated text is checked before it can be sent, and a
 * violation blocks the send the same way a stub does. Same principle as
 * BrightPath's rubric: the model produces, deterministic code decides.
 */

/**
 * Technologies that recur in postings and would be a lie in an email from this
 * profile. An explicit deny-list, not "anything not on an allow-list" — free text
 * is full of capitalised words that are not technology claims, and that direction
 * produces constant false positives.
 */
const FORBIDDEN_TECH = [
  "langchain", "llamaindex", "llama-index", "pinecone", "weaviate", "chroma",
  "hubspot", "salesforce", "pipedrive", "zoho crm", "dynamics",
  "kubernetes", "k8s", "terraform", "ansible", "jenkins",
  "aws", "azure", "gcp", "google cloud", "lambda", "s3", "ec2",
  "kafka", "rabbitmq", "spark", "hadoop", "airflow", "dbt", "snowflake",
  "tensorflow", "pytorch", "scikit-learn", "keras", "hugging face",
  "java", "c++", "c#", ".net", "golang", "rust", "ruby", "rails",
  "php", "laravel", "django", "vue", "angular", "svelte",
  "mongodb", "redis", "elasticsearch", "cassandra", "dynamodb",
  "graphql", "grpc", "kotlin", "swift", "flutter", "react native",
];

/**
 * Tools he does NOT build in but legitimately talks about — they are the problem
 * he is hired to fix. "Your n8n workflow keeps breaking, I rebuild those in real
 * code" is the entire positioning and is true; "I built this with n8n" is false.
 *
 * So these are flagged only inside a first-person skill claim. Treating them like
 * LangChain blocked the whole n8n-rescue pitch on the first full dry run.
 */
const RESCUE_TECH = ["n8n", "zapier", "make.com", "airtable", "bubble", "retool"];

/** First-person possession of a skill, as opposed to describing a client's stack. */
const OWNS_SKILL = [
  /\b(?:i|we)\s+(?:have\s+)?(?:built|build|use|used|develop(?:ed)?|created?|made|write|wrote|implement(?:ed)?)\b[^.!?]{0,40}/i,
  /\bmy\s+(?:stack|experience|background|toolkit|skills?)\b[^.!?]{0,60}/i,
  /\b(?:experienced|proficient|skilled|expert|fluent|certified)\s+(?:in|with)\b[^.!?]{0,40}/i,
  /\bi\s+(?:know|specialise|specialize)\b[^.!?]{0,40}/i,
];

/**
 * Places that are true of him. Compared case-insensitively in code rather than
 * inside the pattern — a case-sensitive lookahead flagged "WAT" as a foreign
 * location on the very first test run.
 */
const OK_PLACES = [
  "nigeria", "wat", "utc", "west africa", "port harcourt", "rivers state",
  "africa", "remote", "your timezone", "european hours", "us hours",
];

/** Words the location pattern can capture that are not places. */
const NOT_A_PLACE =
  /^(the|a|an|order|production|code|real|live|time|place|touch|detail|depth|scope|person|full|part|any|both|line|sync|charge|question|advance|parallel|practice)\b/i;

/**
 * Capitalised words that follow "work in" / "based in" but name a technology,
 * not a location. "I work in TypeScript and Python" was flagged as a claim to be
 * living in TypeScript.
 */
const TECH_NOT_PLACE =
  /^(typescript|javascript|python|react|node|next|postgres|postgresql|sql|solidity|java|go|rust|ruby|php|html|css|bash|docker|git|ai|ml|llm|prod|production|staging|the cloud)\b/i;

const LOCATION_CLAIM =
  /\b(?:i am|i'm|i will be|available|based|located|relocat\w*|work(?:ing)?)\b[^.!?]{0,40}\bin\s+([A-Za-z][A-Za-z.\- ]{1,24})/g;

/** Claims about scale or outcomes the profile cannot support. */
const FORBIDDEN_CLAIMS: [RegExp, string][] = [
  [/\b(\d{2,})\+?\s*(?:clients|customers)\b/i, "client count beyond 'two paid clients'"],
  [/\b(?:[5-9]|[1-9]\d)\+?\s*years?\b/i, "years of experience beyond 1-3"],
  // Words are allowed between verb and figure: "saved the client $40,000".
  [/\b(?:saved|generated|earned|delivered)\b[^.!?]{0,30}\$[\d,]+/i, "an unverified money figure"],
  [/\b(?:increased|reduced|improved|cut|grew)\b[^.!?]{0,30}\b\d+\s?%/i, "an unverified percentage outcome"],
  [/\b(?:led|managed)\s+a\s+team\s+of\s+\d+/i, "team leadership not in the profile"],
  [/\bphd\b|\bmaster'?s\b|\bmsc\b/i, "a degree not held"],
];

export type Violation = { kind: string; found: string };

/**
 * Word-boundary test for a technology name.
 *
 * `\b` fails on "c++" and "c#" because "+" and "#" are already non-word
 * characters. An earlier hand-rolled boundary that excluded "." — to protect
 * "next.js" — then failed to catch "LangChain." at the end of a sentence. So:
 * `\b` where it works, an explicit leading-char check where it does not.
 */
function mentions(text: string, term: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/[+#]/.test(term)) {
    return new RegExp(`(^|[^a-z0-9])${esc}`, "i").test(text);
  }
  return new RegExp(`\\b${esc}\\b`, "i").test(text);
}

export function validateClaims(body: string): Violation[] {
  const v: Violation[] = [];

  for (const t of FORBIDDEN_TECH) {
    if (mentions(body, t)) v.push({ kind: "unsupported technology", found: t });
  }

  // Rescue tools: only a violation when claimed as his own skill.
  for (const t of RESCUE_TECH) {
    if (!mentions(body, t)) continue;
    for (const re of OWNS_SKILL) {
      for (const m of body.match(new RegExp(re, "gi")) ?? []) {
        if (mentions(m, t)) {
          v.push({ kind: "claims skill in a tool he replaces", found: `${t} in "${m.trim().slice(0, 44)}"` });
          break;
        }
      }
    }
  }

  for (const m of body.matchAll(LOCATION_CLAIM)) {
    const place = (m[1] ?? "").trim().replace(/[.\s]+$/, "");
    if (!place || NOT_A_PLACE.test(place) || TECH_NOT_PLACE.test(place)) continue;
    if (OK_PLACES.some((p) => place.toLowerCase().startsWith(p))) continue;
    // Must look like a proper noun; "in production code" is not a place.
    if (!/^[A-Z]/.test(place)) continue;
    v.push({ kind: "location claim", found: place });
  }

  for (const [re, label] of FORBIDDEN_CLAIMS) {
    const m = body.match(re);
    if (m) v.push({ kind: label, found: m[0].trim().slice(0, 40) });
  }

  return v;
}

/** True when the body is safe to send. */
export function claimsOk(body: string): boolean {
  return validateClaims(body).length === 0;
}
