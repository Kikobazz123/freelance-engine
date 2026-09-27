/**
 * Ranking and vetoes. Ported from scripts/verify-ranking.ts and the scoring half
 * of scripts/verify-extra.ts. Fixtures are real titles from the feeds.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  foreignStack, notTechnical, roleMismatch, score, titleFit, type Scorable,
} from "../src/lib/scoring.js";

// score() ages listings against the clock; pin it so results never drift.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());

/** Everything equal except the title, so only the title can separate them. */
const same = (title: string, extra: Partial<Scorable> = {}) => score({
  title, tier: "C", stack_tags: "typescript|python|agents|automation|claude",
  red_flags: "", rate_min: "", rate_type: null, posted_at: new Date().toISOString(),
  market_tier: 1, market_confidence: "high", source: "WWR-All", ...extra,
});

describe("title decides the ranking", () => {
  it("separates roles that used to tie at 100", () => {
    const agent = same("Sticker Mule: AI agent engineer");
    expect(agent.raw).toBeGreaterThan(same("Datadog: Developer Advocate - Service Management EMEA").raw + 20);
    expect(same("AI and Automation Specialist").raw)
      .toBeGreaterThan(same("Data & Insights Technical Consultant (CJA) (100% Remote)").raw + 20);
    expect(agent.raw).toBeGreaterThan(same("Automation & AI Adoption Teaching Expert").raw + 20);
    expect(agent.raw).toBeGreaterThan(same("Proxify AB: Senior QA Automation Engineer").raw);
  });

  it("still orders two jobs that both clamp to 100", () => {
    const agent = same("Sticker Mule: AI agent engineer");
    const agentOpen = same("Sticker Mule: AI agent engineer", { eligibility: "open" });
    expect(agent.score).toBe(100);
    expect(agentOpen.score).toBe(100);
    expect(agentOpen.raw).toBeGreaterThan(agent.raw);
  });
});

describe("titleFit", () => {
  it("recognises the core role and the stack", () => {
    expect(titleFit("Sticker Mule: AI agent engineer").points).toBeGreaterThanOrEqual(18);
    expect(titleFit("Full Stack TypeScript Developer").points).toBeGreaterThanOrEqual(10);
    expect(titleFit("Backend Engineer (Python/TypeScript)").why.some((w) => w.startsWith("title-stack")))
      .toBe(true);
  });

  it("nets an adjacent role negative", () => {
    expect(titleFit("Developer Advocate").points).toBeLessThan(0);
  });
});

describe("preference signals", () => {
  const salaried = same("Backend Engineer");

  it("prefers contract / hourly work", () => {
    expect(same("Backend Engineer", { rate_type: "hourly", rate_min: 45 }).why).toContain("contract+8");
  });

  it("ranks a job explicitly open to him above silence", () => {
    expect(same("Backend Engineer", { eligibility: "open" }).raw).toBe(salaried.raw + 8);
  });

  it("ranks Senior below plain, and Lead below Senior", () => {
    expect(same("Senior Backend Engineer").raw).toBeLessThan(salaried.raw);
    expect(same("Lead Backend Engineer").raw).toBeLessThan(same("Senior Backend Engineer").raw);
  });
});

describe("vetoes are early returns, not large negatives", () => {
  it.each([
    ["not-technical", same("BetterHelp: Licensed Clinical Marriage and Family Therapist")],
    ["not_a_posting", same("anything", { red_flags: "not_a_posting" })],
    ["us_only", same("Senior Full-Stack Engineer [100% remote; US-only]", { red_flags: "us_only" })],
    ["onsite_only", same("Site Reliability Engineer | ONSITE (SF)", { red_flags: "onsite_only" })],
    ["not-engineering", same("Zeta Global: Senior Product Designer, Agentic AI Applications")],
  ])("VETO:%s scores exactly 0", (reason, result) => {
    expect(result).toMatchObject({ score: 0, why: `VETO:${reason}` });
  });
});

describe("notTechnical", () => {
  it.each(["Grid Operator", "Chaplain (Part-Time)", "Voice Actor - UK English Expert", "Coinbase: Accounting Manager"])(
    "vetoes on a job board: %s", (t) => expect(notTechnical(t, "WWR-All")).toBe(true),
  );

  it.each(["AI and Automation Specialist", "Frontend Developer", "Data Platform Lead", "Web Scraping Specialist"])(
    "keeps: %s", (t) => expect(notTechnical(t, "Himalayas-NG-python")).toBe(false),
  );

  it("does not hold marketplace briefs or HN posts to job-title rules", () => {
    expect(notTechnical("Automate Harvest invoice creation", "Freelancer-automation")).toBe(false);
    expect(notTechnical("We're building a unified platform for credit data", "HN-WhoIsHiring")).toBe(false);
  });
});

describe("roleMismatch", () => {
  it.each([
    "Zeta Global: Senior Product Designer, AI",
    "Tines: Deal Desk Analyst",
    "Tines: Lead Customer Success Manager - West",
    "Huntress: Security Operations Analyst",
    "Typeform: AI Product Operations Lead",
  ])("vetoes: %s", (t) => expect(roleMismatch(t)).toBe(true));

  it.each([
    "Interview Resources | 2 Full Stack AI Engineer, 1 GTM | REMOTE",
    "Sticker Mule: AI agent engineer",
    "Datadog: Developer Advocate - Service Management",
    "Acme: Sales Engineer",
    "Senior Product Engineer - Agentic AI (Python/React)",
  ])("keeps: %s", (t) => expect(roleMismatch(t)).toBe(false));
});

describe("foreignStack", () => {
  it.each(["Tech Lead Full-Stack Rails Engineer", "Lemon.io: Senior .NET Full-stack Developer",
    "Senior Java Engineer", "iOS Developer (Swift)"])(
    "penalises: %s", (t) => expect(foreignStack(t)).toBe(true),
  );

  it.each(["Backend Engineer (Python/Go)", "Senior React Native Developer",
    "Full Stack AI Engineer", "JavaScript Developer"])(
    "does not penalise: %s", (t) => expect(foreignStack(t)).toBe(false),
  );
});

describe("market tier in the score", () => {
  const base = {
    title: "Senior AI automation engineer", tier: "A",
    stack_tags: "automation|agents|python|typescript", red_flags: "",
    rate_min: 90, rate_type: "hourly", posted_at: new Date().toISOString(),
  };

  it("vetoes a Tier 3 market even on a perfect listing", () => {
    expect(score({ ...base, market_tier: 3, market_confidence: "high" }).score).toBe(0);
  });

  it("does not penalise an unknown market", () => {
    expect(score({ ...base, market_tier: 0, market_confidence: "low" }).score).toBeGreaterThanOrEqual(85);
  });

  it("lets evidence outrank assumption for the same tier", () => {
    const high = score({ ...base, market_tier: 1, market_confidence: "high" });
    const low = score({ ...base, market_tier: 1, market_confidence: "low" });
    expect(high.score).toBeGreaterThanOrEqual(low.score);
  });
});
