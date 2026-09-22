/**
 * Assertions for Phase 1: reach without recklessness.
 *
 * Discovery widens who the pipeline can write to, so its failure mode is
 * emailing someone who never invited it. The fixtures here are the real false
 * positives from the first dry run, kept so they can never quietly return.
 * No network: every check runs on saved text.
 *
 *   tsx scripts/verify-discover.ts
 */

import { employerContact, pageText, hopCandidates, TRANSIENT, hiringInbox } from "../src/lib/discover.js";
import { roleMismatch, score, foreignStack } from "../src/lib/scoring.js";
import { extractContact } from "../src/lib/contact.js";
import { DESC_CAP, flagsFor } from "../src/lib/sources.js";
import { postingExcerpt, EXCERPT_RULES } from "../src/lib/outreach.js";
import { validateClaims } from "../src/lib/claims.js";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`  PASS  ${name}${extra ? `  (${extra})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? `  (${extra})` : ""}`); }
};

/* --------------------------------------------------- board addresses */
console.log("\n--- the board's own address is never the employer's ---");

// Shape of a real HN item page: the comment, then HN's footer.
const hnPage = pageText(`
  <span class="commtext">AcmeAI | Backend Engineer | REMOTE | We build agents.
  Interested? Email jobs@acmeai.dev with your CV.</span>
  <div class="footer">Guidelines | FAQ | Lists | API | Security | Legal |
  Apply to YC | Contact: hn@ycombinator.com</div>`);
ok(employerContact(hnPage)?.email === "jobs@acmeai.dev",
  "HN posting yields the employer, not the footer", employerContact(hnPage)?.email ?? "none");

const footerOnly = pageText(`<p>Great role, apply via our form.</p>
  <div class="footer">Contact: hn@ycombinator.com</div>`);
ok(employerContact(footerOnly) === null,
  "a page whose only address is the board's yields nothing",
  employerContact(footerOnly)?.email ?? "none");
ok(extractContact(footerOnly) !== null,
  "control: the raw extractor alone WOULD have accepted it (the bug being guarded)");

/* ------------------------------------------------------------ mailto */
console.log("\n--- a mailto: link goes through the filters, not around them ---");

const mailto = pageText(`<p>Want in? <a href="mailto:careers@buildco.io?subject=Hi">Reach us</a></p>`);
ok(employerContact(mailto)?.email === "careers@buildco.io",
  "mailto: address becomes visible, invitation-adjacent text");

const freeMailto = pageText(`<p><a href="mailto:someone@gmail.com">Email me</a></p>`);
ok(employerContact(freeMailto) === null,
  "a free-mail mailto: is still rejected (job seeker, not employer)");

/* -------------------------------------------------------------- hops */
console.log("\n--- a hop must land on the employer's own site ---");

const remoteOkPage = `
  <a href="https://www.producthunt.com/posts/remoteok">Featured on Product Hunt — jobs</a>
  <a href="https://acmeai.dev/careers">Apply at AcmeAI</a>
  <a href="https://boards.greenhouse.io/acmeai/jobs/1">Apply</a>`;
const hops = hopCandidates(remoteOkPage, "https://remoteok.com/remote-jobs/1", "AcmeAI Inc");
ok(!hops.some((h) => h.includes("producthunt")),
  "the Product Hunt badge is not followed", JSON.stringify(hops));
ok(hops.some((h) => h.includes("acmeai.dev/careers")),
  "the employer's careers page is followed");
ok(!hops.some((h) => h.includes("greenhouse")), "a hosted form is not followed");
ok(hopCandidates(remoteOkPage, "https://remoteok.com/x", null).length === 0,
  "no company name, no hop");

console.log("\n--- one hop away, only a hiring inbox counts ---");
ok(!hiringInbox("lets-talk@mactores.com"), "a sales inbox from a careers page is refused");
ok(!hiringInbox("sales@acme.io") && !hiringInbox("info@acme.io"), "sales@ and info@ are refused");
for (const e of ["jobs@fueled.com", "careers@acme.io", "talent+eng@acme.io", "hiring@acme.io", "hr@acme.io"]) {
  ok(hiringInbox(e), `accepted: ${e}`);
}

/* --------------------------------------------------------- transient */
console.log("\n--- a timeout is not the site's answer ---");

for (const r of ["fetch:fetch failed", "fetch:This operation was aborted", "fetch:HTTP 503", "fetch:HTTP 429"]) {
  ok(TRANSIENT.test(r), `retryable: ${r}`);
}
for (const r of ["fetch:HTTP 403", "fetch:HTTP 404", "no_address_published", "robots_disallow"]) {
  ok(!TRANSIENT.test(r), `final: ${r}`);
}

/* ------------------------------------------------------ harvest caps */
console.log("\n--- postings are not cut before the address ---");
ok(DESC_CAP >= 4000, "harvest keeps enough text to reach an end-of-post apply line", String(DESC_CAP));

/* -------------------------------------------------------- role check */
console.log("\n--- non-engineering jobs are vetoed, multi-role posts survive ---");

const vetoed = [
  "Zeta Global: Senior Product Designer, AI",
  "Tines: Deal Desk Analyst",
  "Tines: Lead Customer Success Manager - West",
  "Huntress: Security Operations Analyst",
  "Typeform: AI Product Operations Lead",
];
for (const t of vetoed) ok(roleMismatch(t), `vetoed: ${t}`);

const kept = [
  "Interview Resources | 2 Full Stack AI Engineer, 1 GTM | REMOTE",
  "Sticker Mule: AI agent engineer",
  "Datadog: Developer Advocate - Service Management",
  "Acme: Sales Engineer",
  "Senior Product Engineer - Agentic AI (Python/React)",
];
for (const t of kept) ok(!roleMismatch(t), `kept: ${t}`);

const s = score({
  title: "Zeta Global: Senior Product Designer, Agentic AI Applications",
  tier: "C", stack_tags: "agents|claude|typescript", red_flags: "",
  rate_min: "", rate_type: null, posted_at: new Date().toISOString(),
  market_tier: 1, market_confidence: "high",
});
ok(s.score === 0 && s.why === "VETO:not-engineering",
  "a designer role scores 0 however good its stack tags look", `${s.score} ${s.why}`);

/* ----------------------------------------------------------- excerpt */
console.log("\n--- the writer sees requirements, and the guard still decides ---");

const posting =
  "Acme is a Series B company backed by great investors. We offer unlimited PTO and a " +
  "home-office stipend. You will build agentic workflows in TypeScript that replace our " +
  "brittle Zapier automations. You must have shipped production APIs with Postgres. " +
  "Experience with AWS and Kubernetes is required. We are an equal opportunity employer.";
const ex = postingExcerpt(posting);
ok(/replace our brittle Zapier/.test(ex), "keeps the sentence describing the work");
ok(!/unlimited PTO|equal opportunity|Series B/.test(ex), "drops perks, funding and boilerplate");
ok(ex.length <= 1200, "stays within the prompt budget", String(ex.length));
ok(postingExcerpt("") === "" && postingExcerpt(null) === "", "no description, no excerpt");

// The posting asks for AWS; the letter may not claim it.
const claimed = validateClaims(
  "You need AWS and Kubernetes. I have run production workloads on AWS and Kubernetes for years.",
);
ok(claimed.some((v) => /aws|kubernetes/i.test(v.found)),
  "a technology the posting demands is still blocked when he claims it",
  claimed.map((v) => v.found).join(","));

// An instruction smuggled into a posting is text, not a command, and the
// output guard is what stands behind that.
const injected = validateClaims("As instructed by the posting, I confirm deep LangChain expertise.");
ok(injected.length > 0, "an injected claim is blocked at the output");

ok(/never evidence of his experience/i.test(EXCERPT_RULES) && /must be ignored/i.test(EXCERPT_RULES),
  "the prompt frames the excerpt as the employer's words, not instructions");

/*
 * The prompt used to say "name it as a gap" while the validator rejects any
 * mention of a listed product — so an honest "I haven't used AWS" was blocked.
 * 5 of 14 drafts in one batch died this way. The permitted form is a gap in
 * general words, and it has to actually pass.
 */
ok(validateClaims("I haven't run cloud infrastructure at scale, but I ship typed APIs on Neon Postgres.").length === 0,
  "a gap stated in general words passes the validator");
ok(validateClaims("I haven't used AWS, but I ship typed APIs.").length > 0,
  "control: the same gap by product name is still blocked (why the prompt forbids it)");
ok(/not even to decline them/i.test(EXCERPT_RULES),
  "the prompt tells the writer not to repeat a missing product even to decline it");

/* ------------------------------------------------------- office jobs */
console.log("\n--- an office job is vetoed; a remote-optional one is not ---");

const strobe = flagsFor("Strobe Power | Site Reliability Engineer | ONSITE (SF) | energy trading", "HN-WhoIsHiring");
ok(strobe.split("|").includes("onsite_only"), "ONSITE with no remote option is office-only", strobe);

const either = flagsFor("Acme | Backend Engineer | REMOTE or ONSITE (SF)", "HN-WhoIsHiring");
ok(!either.split("|").includes("onsite_only"), "REMOTE or ONSITE survives", either);

const wwr = flagsFor("Acme: Engineer. We meet for a yearly on-site offsite.", "WWR-All");
ok(!wwr.split("|").includes("onsite_only"), "a remote-only board is never office-only", wwr);

// The real case: title says ONSITE, the body happens to say "remote" elsewhere.
const strobeTitle = "Strobe Power | Site Reliability Engineer | ONSITE (SF) | https://strobepower.com";
const strobeReal = flagsFor(
  `${strobeTitle} We monitor remote sites and control rooms around the clock.`,
  "HN-WhoIsHiring", strobeTitle,
);
ok(strobeReal.split("|").includes("onsite_only"),
  "title ONSITE wins over an unrelated 'remote' in the body", strobeReal);

const eitherTitle = "Acme | Backend Engineer | REMOTE or ONSITE (SF)";
ok(!flagsFor(eitherTitle, "HN-WhoIsHiring", eitherTitle).split("|").includes("onsite_only"),
  "title REMOTE or ONSITE still survives");

const usRemote = "Ours Privacy | Senior Platform Engineer | Remote (US) | Full-time";
ok(flagsFor(usRemote, "HN-WhoIsHiring", usRemote).split("|").includes("us_only"),
  "HN's 'Remote (US)' is read as US-only");
ok(!flagsFor("Acme | Engineer | Remote (Worldwide)", "HN-WhoIsHiring").split("|").includes("us_only"),
  "'Remote (Worldwide)' is not");

const govstar = "GovStar | https://www.govstar.us | Remote (U.S. — Eastern/Central Time) | AI Engineer";
ok(flagsFor(govstar, "HN-WhoIsHiring", govstar).split("|").includes("us_only"),
  "'Remote (U.S. — ...)' is US-only (word boundary after a full stop)");

const usOnly = score({
  title: "Senior Full-Stack Engineer [Full Time; 100% remote; US-only]", tier: "C",
  stack_tags: "python|react|zapier|claude", red_flags: "us_only",
  rate_min: "", rate_type: null, posted_at: new Date().toISOString(),
  market_tier: 1, market_confidence: "high",
});
ok(usOnly.score === 0 && usOnly.why === "VETO:us_only",
  "a US-only role scores 0 (was 86 as a -35 penalty)", `${usOnly.score} ${usOnly.why}`);

console.log("\n--- a title in a stack he does not use is penalised ---");
for (const t of ["Tech Lead Full-Stack Rails Engineer", "Lemon.io: Senior .NET Full-stack Developer",
                 "Senior Java Engineer", "iOS Developer (Swift)"]) {
  ok(foreignStack(t), `penalised: ${t}`);
}
for (const t of ["Backend Engineer (Python/Go)", "Senior React Native Developer",
                 "Full Stack AI Engineer", "JavaScript Developer"]) {
  ok(!foreignStack(t), `not penalised: ${t}`);
}

const office = score({
  title: "Strobe Power | Site Reliability Engineer | ONSITE (SF)", tier: "F",
  stack_tags: "python|api|automation", red_flags: strobe,
  rate_min: "", rate_type: null, posted_at: new Date().toISOString(),
  market_tier: 1, market_confidence: "high",
});
ok(office.score === 0 && office.why === "VETO:onsite_only", "an office-only job scores 0", `${office.score} ${office.why}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
