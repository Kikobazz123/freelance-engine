/**
 * Contact discovery: widening who the pipeline can write to must not mean
 * emailing someone who never invited it. Fixtures are real false positives from
 * the first dry run. Formerly scripts/verify-discover.ts; no network.
 */
import { describe, expect, it } from "vitest";
import { employerContact, hiringInbox, hopCandidates, pageText, TRANSIENT } from "../src/lib/discover.js";
import { extractContact } from "../src/lib/contact.js";
import { DESC_CAP, flagsFor } from "../src/lib/sources.js";

const has = (flags: string, f: string) => flags.split("|").includes(f);

describe("employerContact", () => {
  it("takes the employer's address from an HN page, not the footer", () => {
    const page = pageText(`
      <span class="commtext">AcmeAI | Backend Engineer | REMOTE | We build agents.
      Interested? Email jobs@acmeai.dev with your CV.</span>
      <div class="footer">Guidelines | FAQ | Lists | API | Security | Legal |
      Apply to YC | Contact: hn@ycombinator.com</div>`);
    expect(employerContact(page)?.email).toBe("jobs@acmeai.dev");
  });

  it("yields nothing when the only address is the board's", () => {
    const page = pageText(`<p>Great role, apply via our form.</p>
      <div class="footer">Contact: hn@ycombinator.com</div>`);
    expect(employerContact(page)).toBeNull();
    // Control: the raw extractor alone would have accepted it (the bug being guarded).
    expect(extractContact(page)).not.toBeNull();
  });

  it("runs mailto: links through the same filters", () => {
    expect(employerContact(pageText(`<p>Want in? <a href="mailto:careers@buildco.io?subject=Hi">Reach us</a></p>`))?.email)
      .toBe("careers@buildco.io");
    expect(employerContact(pageText(`<p><a href="mailto:someone@gmail.com">Email me</a></p>`))).toBeNull();
  });
});

describe("hopCandidates", () => {
  const page = `
    <a href="https://www.producthunt.com/posts/remoteok">Featured on Product Hunt — jobs</a>
    <a href="https://acmeai.dev/careers">Apply at AcmeAI</a>
    <a href="https://boards.greenhouse.io/acmeai/jobs/1">Apply</a>`;

  it("follows only the employer's own site", () => {
    const hops = hopCandidates(page, "https://remoteok.com/remote-jobs/1", "AcmeAI Inc");
    expect(hops.some((h) => h.includes("acmeai.dev/careers"))).toBe(true);
    expect(hops.some((h) => h.includes("producthunt"))).toBe(false);
    expect(hops.some((h) => h.includes("greenhouse"))).toBe(false);
  });

  it("does not hop without a company name", () => {
    expect(hopCandidates(page, "https://remoteok.com/x", null)).toEqual([]);
  });
});

describe("hiringInbox", () => {
  it.each(["lets-talk@mactores.com", "sales@acme.io", "info@acme.io"])("refuses %s", (e) =>
    expect(hiringInbox(e)).toBe(false));
  it.each(["jobs@fueled.com", "careers@acme.io", "talent+eng@acme.io", "hiring@acme.io", "hr@acme.io"])(
    "accepts %s", (e) => expect(hiringInbox(e)).toBe(true));
});

describe("TRANSIENT", () => {
  it.each(["fetch:fetch failed", "fetch:This operation was aborted", "fetch:HTTP 503", "fetch:HTTP 429"])(
    "retries %s", (r) => expect(TRANSIENT.test(r)).toBe(true));
  it.each(["fetch:HTTP 403", "fetch:HTTP 404", "no_address_published", "robots_disallow"])(
    "treats %s as final", (r) => expect(TRANSIENT.test(r)).toBe(false));
});

describe("flagsFor", () => {
  it("keeps enough posting text to reach an end-of-post apply line", () => {
    expect(DESC_CAP).toBeGreaterThanOrEqual(4000);
  });

  it("flags ONSITE with no remote option as office-only", () => {
    expect(has(flagsFor("Strobe Power | Site Reliability Engineer | ONSITE (SF) | energy trading", "HN-WhoIsHiring"),
      "onsite_only")).toBe(true);
  });

  it("does not flag REMOTE or ONSITE, or a remote-only board", () => {
    const either = "Acme | Backend Engineer | REMOTE or ONSITE (SF)";
    expect(has(flagsFor(either, "HN-WhoIsHiring"), "onsite_only")).toBe(false);
    expect(has(flagsFor(either, "HN-WhoIsHiring", either), "onsite_only")).toBe(false);
    expect(has(flagsFor("Acme: Engineer. We meet for a yearly on-site offsite.", "WWR-All"), "onsite_only")).toBe(false);
  });

  it("lets a title ONSITE win over an unrelated 'remote' in the body", () => {
    const title = "Strobe Power | Site Reliability Engineer | ONSITE (SF) | https://strobepower.com";
    const flags = flagsFor(`${title} We monitor remote sites and control rooms around the clock.`, "HN-WhoIsHiring", title);
    expect(has(flags, "onsite_only")).toBe(true);
  });

  it("reads HN's 'Remote (US)' variants as US-only, but not 'Remote (Worldwide)'", () => {
    const us = "Ours Privacy | Senior Platform Engineer | Remote (US) | Full-time";
    const govstar = "GovStar | https://www.govstar.us | Remote (U.S. — Eastern/Central Time) | AI Engineer";
    expect(has(flagsFor(us, "HN-WhoIsHiring", us), "us_only")).toBe(true);
    expect(has(flagsFor(govstar, "HN-WhoIsHiring", govstar), "us_only")).toBe(true);
    expect(has(flagsFor("Acme | Engineer | Remote (Worldwide)", "HN-WhoIsHiring"), "us_only")).toBe(false);
  });
});
