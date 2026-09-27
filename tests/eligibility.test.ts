/**
 * Eligibility against real location strings, copied verbatim from the feeds on
 * 2026-09-22. Formerly scripts/verify-eligibility.ts.
 */
import { describe, expect, it } from "vitest";
import { eligibility, type Eligibility } from "../src/lib/eligibility.js";
import { score } from "../src/lib/scoring.js";

const cases: Record<Eligibility, (string | string[])[]> = {
  open: [
    "Anywhere in the World",
    "Worldwide",
    "Anywhere",
    "APAC,  EMEA",
    "Global",
    "Internationally located (not in the US, CA, UK, NZ, or AU)",
    "Remote (Worldwide) - Working East Coast Hours",
    "Time zone: CET (+/- 3 hours)",
    ["Nigeria", "Kenya"],
    "UTC+1",
  ],
  us_only: [
    "USA Only",
    "North America Only",
    "USA, Canada, USA timezones",
    "United States",
    "Remote - USA",
    ["Canada", "United States"],
    "New York, New York, New York, United States",
    "USA, Canada, Argentina, Mexico, Peru",
  ],
  region_locked: [
    "Anywhere in India",
    "LATAM",
    "Australia & New Zealand (REMOTE)",
    "Philippines, Nicaragua, South Africa, Guatemala",
    ["Mexico"],
  ],
  eu_only: ["Europe", "Europe,  UK", "United Kingdom", ["Germany"], "Americas, Europe, Israel"],
  // Silence is not evidence.
  unknown: ["", "Chennai, ", "Remote"],
};

describe("eligibility", () => {
  for (const [want, inputs] of Object.entries(cases)) {
    it.each(inputs.map((i) => [JSON.stringify(i), i]))(`%s -> ${want}`, (_label, input) => {
      expect(eligibility(input)).toBe(want);
    });
  }
});

describe("eligibility reaches the score", () => {
  const base = {
    title: "Backend Engineer (Python)", tier: "C", stack_tags: "python|api|automation",
    rate_min: "" as const, rate_type: null, posted_at: new Date().toISOString(),
    market_tier: 1 as const, market_confidence: "high" as const,
  };

  it("vetoes a region-locked job", () => {
    const locked = score({ ...base, red_flags: "region_locked" });
    expect(locked).toMatchObject({ score: 0, why: "VETO:region_locked" });
  });

  it("penalises a Europe-only job without vetoing it", () => {
    const eu = score({ ...base, red_flags: "eu_only" });
    const open = score({ ...base, red_flags: "" });
    expect(eu.score).toBeGreaterThan(0);
    expect(eu.score).toBeLessThan(open.score);
  });
});
