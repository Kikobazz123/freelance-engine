/**
 * Lane A email composition.
 *
 * What this lane is, precisely: replying to someone who published an address
 * asking applicants to write. It is an application, not unsolicited outreach.
 * That distinction is what makes automating it reasonable, and it is also why
 * the rules below are narrow — the moment this starts writing to addresses that
 * were not offered for the purpose, it becomes something else entirely and the
 * safeguards would need to be different.
 *
 * Every send still carries a real identity, a real location and a working
 * opt-out, because a recipient should be able to end it in one reply.
 */

import { completeValidated } from "./llm.js";
import { IDENTITY, VERIFIABLE_WORK, HONEST_GAPS } from "../config.js";
import { validateClaims } from "./claims.js";

export const SENDER_NAME = IDENTITY.name;
export const SENDER_LOCATION = IDENTITY.location;

const SYSTEM = `
You write short job application emails for the engineer described below.

Rules, in priority order:
1. NEVER claim experience not in the profile.
2. Mention a gap ONLY if THIS posting actually asks for that thing. Volunteering an
   unrelated weakness reads as odd and costs you the reply — do not tell a company
   that never mentioned CRM that you lack CRM experience. If the posting does ask
   for something absent, name it in one clause and move on: an honest gap beats a
   bluff that collapses on the first call.
3. Under 120 words. The recipient is reading dozens of these.
4. Open with what you can do for their specific problem. No "I hope this finds you
   well", no "I am writing to express my interest".
5. Cite ONE concrete build with a real number or detail.
6. Close with a single clear next step.
7. Plain language. No "leverage", "passionate", "rockstar", "synergy", "excited".
8. Do not invent names, availability dates, prices or results.

NEVER NAME THESE — he has not used them, and the validator will reject the whole
email if you do. If the posting asks for one, either ignore it or name it as a gap:
  AWS, Azure, GCP, Kubernetes, Terraform, Docker Swarm, Jenkins,
  LangChain, LlamaIndex, Pinecone, Weaviate,
  HubSpot, Salesforce, Pipedrive, or any named CRM platform,
  Kafka, Airflow, Snowflake, Spark, dbt,
  TensorFlow, PyTorch, scikit-learn,
  Java, C#, .NET, Go, Rust, Ruby, Rails, PHP, Laravel, Django, Vue, Angular,
  MongoDB, Redis, Elasticsearch, GraphQL.

You may say a CLIENT uses n8n / Zapier / Make / Airtable and that he replaces them
with code — that is the pitch. Never say HE builds in them.

He works remotely from the location in the profile. Never state or imply he is in,
or moving to, any other place. Offering timezone overlap is fine.

Return ONLY the email body. No subject line, no greeting line with a name you do
not know, no signature block — those are added separately.
`.trim();

const PROFILE = [
  `${IDENTITY.title}. ${IDENTITY.company}. ${IDENTITY.location} (${IDENTITY.timezone}),
   remote.`,
  ``,
  `VERIFIABLE WORK ONLY:`,
  VERIFIABLE_WORK,
  ``,
  `HONEST GAPS:`,
  HONEST_GAPS,
].join("\n");

export type Target = {
  title: string;
  company: string | null;
  url: string;
  source: string;
  contact_email: string;
  fit_score: number;
  stack_tags: string[] | null;
};

/**
 * Kept short and specific — a vague subject is deleted unread.
 *
 * Truncates on a word boundary. A hard slice produced
 * "…+ PhD Researcher (pa — Your Name", which looks like a broken mail merge
 * and undoes the point of a careful email.
 */
export function subjectFor(t: Target): string {
  let role = t.title
    .replace(/^[^|]*\|\s*/, "")       // HN posts lead with the company name
    .replace(/\s*\|.*$/, "")          // drop everything after the next pipe
    .replace(/\s*\+.*$/, "")          // "Engineer + PhD Researcher" -> "Engineer"
    .replace(/\s+/g, " ")
    .trim();

  const MAX = 52;
  if (role.length > MAX) {
    const cut = role.slice(0, MAX);
    const lastSpace = cut.lastIndexOf(" ");
    role = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[\s(,\-–—]+$/, "");
  }

  return `Application: ${role || "engineering role"} — ${SENDER_NAME}`;
}

/**
 * The footer is not decoration. Real name, real location and a one-line opt-out
 * that a human actually honours (see suppression handling in send-lane-a).
 */
export function footerFor(): string {
  return [
    ``,
    `—`,
    `${SENDER_NAME}`,
    `AI Automation Engineer · LordGen`,
    `${SENDER_LOCATION}`,
    `github.com/${IDENTITY.githubUser} · ${IDENTITY.linkedin}`,
    ``,
    `Reply "no thanks" and I won't contact you again.`,
  ].join("\n");
}

export async function composeApplication(
  t: Target,
): Promise<{ subject: string; body: string; provider: string }> {
  const user = [
    `POSTING`,
    `Title: ${t.title}`,
    `Company: ${t.company ?? "unknown"}`,
    `Source: ${t.source}`,
    `Stack signals: ${(t.stack_tags ?? []).join(", ") || "none detected"}`,
    `Listing: ${t.url}`,
    ``,
    `PROFILE`,
    PROFILE,
  ].join("\n");

  const res = await completeValidated(SYSTEM, user, validateClaims);

  // No provider reachable: return a stub that is obviously unsendable rather than
  // an empty or invented email. send-lane-a refuses to send anything stubbed.
  if (res.provider === "stub" || !res.text) {
    return {
      subject: subjectFor(t),
      body: `[STUB — no LLM provider available, nothing generated]`,
      provider: "stub",
    };
  }

  return {
    subject: subjectFor(t),
    body: res.text.trim() + "\n" + footerFor(),
    provider: res.provider,
  };
}

/** A stub must never reach a recipient. Checked again at the send boundary. */
export function isStub(body: string): boolean {
  return body.startsWith("[STUB");
}
