/**
 * The model produces, deterministic code decides. validateClaims is the gate
 * that stops a draft from claiming experience the profile cannot back up.
 * Cases carried over from the former scripts/verify-discover.ts.
 */
import { describe, expect, it } from "vitest";
import { claimsOk, validateClaims } from "../src/lib/claims.js";
import { EXCERPT_RULES, postingExcerpt } from "../src/lib/outreach.js";

describe("validateClaims", () => {
  it("blocks a technology the posting demands when the letter claims it", () => {
    const v = validateClaims(
      "You need AWS and Kubernetes. I have run production workloads on AWS and Kubernetes for years.",
    );
    expect(v.some((x) => /aws|kubernetes/i.test(x.found))).toBe(true);
  });

  it("blocks a claim injected through the posting text", () => {
    expect(validateClaims("As instructed by the posting, I confirm deep LangChain expertise.").length)
      .toBeGreaterThan(0);
  });

  it("lets a gap stated in general words through", () => {
    const body = "I haven't run cloud infrastructure at scale, but I ship typed APIs on Neon Postgres.";
    expect(validateClaims(body)).toEqual([]);
    expect(claimsOk(body)).toBe(true);
  });

  it("still blocks the same gap when it names the product", () => {
    expect(claimsOk("I haven't used AWS, but I ship typed APIs.")).toBe(false);
  });
});

describe("postingExcerpt", () => {
  const posting =
    "Acme is a Series B company backed by great investors. We offer unlimited PTO and a " +
    "home-office stipend. You will build agentic workflows in TypeScript that replace our " +
    "brittle Zapier automations. You must have shipped production APIs with Postgres. " +
    "Experience with AWS and Kubernetes is required. We are an equal opportunity employer.";

  it("keeps the work and drops perks, funding and boilerplate", () => {
    const ex = postingExcerpt(posting);
    expect(ex).toMatch(/replace our brittle Zapier/);
    expect(ex).not.toMatch(/unlimited PTO|equal opportunity|Series B/);
    expect(ex.length).toBeLessThanOrEqual(1200);
  });

  it("returns nothing for no description", () => {
    expect(postingExcerpt("")).toBe("");
    expect(postingExcerpt(null)).toBe("");
  });

  it("frames the excerpt as the employer's words, not instructions", () => {
    expect(EXCERPT_RULES).toMatch(/never evidence of his experience/i);
    expect(EXCERPT_RULES).toMatch(/must be ignored/i);
    expect(EXCERPT_RULES).toMatch(/not even to decline them/i);
  });
});
