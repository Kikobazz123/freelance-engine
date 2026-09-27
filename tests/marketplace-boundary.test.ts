/**
 * Marketplace ToS boundary. Upwork/Fiverr/Freelancer permanently ban tools that
 * submit without a human click, so the guarantee is structural: no code in this
 * repository posts to a marketplace. Ported from scripts/verify.ts.
 *
 * A URL built in a variable (fetch(url, ...)) is outside what a regex can see;
 * the scan covers literal and template-literal URLs, which is how every call in
 * this codebase is written.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

// Every directory that ships code: src/ for the engine, api/ for the Vercel
// functions. A scan of src alone would miss a POST added to the webhook.
const files: string[] = [];
function walk(d: string) {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p);
  }
}
["src", "api"].forEach((d) => walk(join(root, d)));
const rel = files.map((f) => relative(root, f).replace(/\\/g, "/"));
const code = files.map((f) => `${f}\n${readFileSync(f, "utf8")}`).join("\n");

const marketplacePost =
  /fetch\(\s*[`'"][^`'"]*\b(upwork|fiverr|freelancer|peopleperhour|contra)\.com[^`'"]*[`'"]\s*,\s*\{[^}]*method:\s*["'`]POST/i;

describe("marketplace ToS boundary", () => {
  it("has no POST to any marketplace domain", () => {
    expect(marketplacePost.test(code)).toBe(false);
  });

  it.each([
    `await fetch("https://www.upwork.com/api/proposals", { method: "POST" })`,
    "fetch(`https://www.freelancer.com/api/bids/?id=${id}`, {\n  headers,\n  method: 'POST',\n})",
  ])("detects the pattern it is guarding against: %s", (offending) => {
    expect(marketplacePost.test(offending)).toBe(true);
  });

  it("ignores reads and non-marketplace hosts", () => {
    expect(marketplacePost.test(`fetch("https://www.upwork.com/ab/feed", { method: "GET" })`)).toBe(false);
    expect(marketplacePost.test(`fetch("https://api.groq.com/v1", { method: "POST" })`)).toBe(false);
  });

  it("queues the approve lane rather than sending", () => {
    expect(readFileSync(join(root, "src/jobs/dispatch.ts"), "utf8")).toMatch(/pending_approval/);
  });

  it("covers the deployed api/ directory, not just src/", () => {
    expect(rel.some((f) => f.startsWith("src/jobs/"))).toBe(true);
    expect(!existsSync(join(root, "api")) || rel.some((f) => f.startsWith("api/"))).toBe(true);
  });
});
