/**
 * Client-market detection. Ported from the geo half of scripts/verify-extra.ts.
 * The expensive error is a wrong veto, so ambiguity must resolve to "unknown".
 */
import { describe, expect, it } from "vitest";
import { marketOf } from "../src/lib/geo.js";
import { FREE_ALLOWANCE, platformOf } from "../src/lib/db.js";

describe("marketOf", () => {
  it("resolves an unstated location to unknown, not a veto", () => {
    expect(marketOf("Build me an AI agent", "SomeFeed", "https://example.com/1").tier).toBe(0);
  });

  it("resolves conflicting Tier 1 + Tier 3 signals to unknown", () => {
    // A real false positive found auditing 982 live listings.
    const hit = marketOf("Oscilar | Sr Engineers | REMOTE (US/Canada) | also hiring in India", "X", "https://x.com");
    expect(hit.tier).toBe(0);
  });

  it("identifies a positively low-rate market as Tier 3", () => {
    expect(marketOf("Wordpress dev needed, budget 15000 INR, Mumbai team", "X", "https://x.in/j").tier).toBe(3);
  });

  it('does not read "contact us" as the United States', () => {
    expect(marketOf("Please contact us about this role", "X", "https://x.com").market).not.toBe("US");
  });

  it("treats a currency symbol plus a city as high-confidence Tier 1", () => {
    expect(marketOf("Automation engineer, £500/day, London", "X", "https://x.com"))
      .toMatchObject({ tier: 1, confidence: "high" });
  });

  it("marks feed-level inference as low confidence", () => {
    expect(marketOf("Backend engineer", "WWR-All", "https://weworkremotely.com/x").confidence).toBe("low");
  });
});

describe("bid rationing constants", () => {
  it("knows each marketplace's free allowance", () => {
    expect(FREE_ALLOWANCE.freelancer.n).toBe(6);
    expect(FREE_ALLOWANCE.upwork.n).toBe(10);
  });

  it("maps sources to the budget they spend", () => {
    expect(platformOf("Freelancer-ai-agent")).toBe("freelancer");
    expect(platformOf("WWR-All")).toBeNull();
  });
});
