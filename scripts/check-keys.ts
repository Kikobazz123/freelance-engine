/**
 * Live credential check. Calls each configured provider with a minimal request
 * and reports what actually happened — format checks cannot tell a revoked key
 * from a valid one, and a key that looks right but 401s is worse than a missing
 * one because it fails silently at 05:15.
 *
 * Never prints a key. Never prints a response body that could echo one.
 *
 *   tsx scripts/check-keys.ts
 */

import "dotenv/config";
import { complete } from "../src/lib/llm.js";

const line = (s: string, ok: boolean | null, detail = "") =>
  console.log(`  ${ok === null ? "SKIP" : ok ? "OK  " : "FAIL"}  ${s.padEnd(20)} ${detail}`);

const TIMEOUT = 25_000;
async function timed(p: Promise<Response>): Promise<Response> {
  return await Promise.race([
    p,
    new Promise<Response>((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT)),
  ]);
}

console.log("\n--- LLM providers (proposal generation) ---");

// Groq
{
  const k = process.env.GROQ_API_KEY;
  if (!k) line("Groq", null, "no key set");
  else {
    try {
      const r = await timed(fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${k}` },
      }));
      if (r.ok) {
        const j = (await r.json()) as { data?: { id: string }[] };
        const want = process.env.GROQ_MODEL ?? "qwen/qwen3.8-27b";
        const has = j.data?.some((m) => m.id === want);
        line("Groq", true, `${j.data?.length ?? 0} models; "${want}" ${has ? "available" : "NOT FOUND"}`);
        if (!has && j.data?.length) {
          const alt = j.data.filter((m) => /llama|qwen|kimi/i.test(m.id)).slice(0, 4).map((m) => m.id);
          console.log(`        alternatives: ${alt.join(", ")}`);
        }
      } else line("Groq", false, `HTTP ${r.status} — key rejected`);
    } catch (e) { line("Groq", false, String((e as Error).message).slice(0, 60)); }
  }
}

// Gemini
{
  const k = process.env.GEMINI_API_KEY;
  if (!k) line("Gemini", null, "no key set");
  else {
    try {
      const r = await timed(fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${k}`));
      if (r.ok) {
        const j = (await r.json()) as { models?: { name: string }[] };
        const want = process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest";
        const has = j.models?.some((m) => m.name.endsWith(want));
        line("Gemini", true, `${j.models?.length ?? 0} models; "${want}" ${has ? "available" : "NOT FOUND"}`);
        if (!has && j.models?.length) {
          const alt = j.models.map((m) => m.name.replace("models/", ""))
            .filter((n) => /flash/i.test(n)).slice(0, 4);
          console.log(`        flash models available: ${alt.join(", ")}`);
        }
      } else {
        const body = await r.text();
        const reason = /API_KEY_INVALID/.test(body) ? "API_KEY_INVALID"
          : /API key not valid/.test(body) ? "key not valid"
          : /PERMISSION_DENIED/.test(body) ? "PERMISSION_DENIED"
          : /SERVICE_DISABLED/.test(body) ? "Generative Language API not enabled"
          : `HTTP ${r.status}`;
        line("Gemini", false, reason);
      }
    } catch (e) { line("Gemini", false, String((e as Error).message).slice(0, 60)); }
  }
}

// OpenRouter
{
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) line("OpenRouter", null, "no key set");
  else {
    try {
      const r = await timed(fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${k}` },
      }));
      if (r.ok) {
        const j = (await r.json()) as { data?: { limit: number | null; usage: number } };
        const lim = j.data?.limit === null ? "no hard limit" : `limit ${j.data?.limit}`;
        line("OpenRouter", true, `${lim}, used ${j.data?.usage ?? 0}`);
      } else line("OpenRouter", false, `HTTP ${r.status} — key rejected`);
    } catch (e) { line("OpenRouter", false, String((e as Error).message).slice(0, 60)); }
  }
}

console.log("\n--- Telegram ---");
{
  const t = process.env.TELEGRAM_BOT_TOKEN;
  const c = process.env.TELEGRAM_CHAT_ID;
  if (!t) line("Bot token", null, "no token set");
  else {
    try {
      const r = await timed(fetch(`https://api.telegram.org/bot${t}/getMe`));
      const j = (await r.json()) as { ok: boolean; result?: { username: string } };
      j.ok ? line("Bot token", true, `@${j.result?.username}`)
           : line("Bot token", false, "rejected by Telegram");
    } catch (e) { line("Bot token", false, String((e as Error).message).slice(0, 60)); }
  }
  if (!c) line("Chat ID", null, "no chat id set");
  else line("Chat ID", /^-?\d{6,}$/.test(c), c);
}

console.log("\n--- Neon ---");
{
  try {
    const { sql } = await import("../src/lib/db.js");
    const [r] = (await sql`SELECT count(*)::int AS n FROM listings`) as { n: number }[];
    line("Database", true, `${r.n} listings`);
  } catch (e) { line("Database", false, String((e as Error).message).slice(0, 60)); }
}

console.log("\n--- end-to-end: can a proposal actually be generated? ---");
{
  const res = await complete(
    "Reply with exactly the word: READY",
    "Say READY and nothing else.",
  );
  if (res.provider === "stub") {
    line("Proposal gen", false, "ALL providers failed — would emit stubs");
    for (const a of res.attempts) console.log(`        ${a.provider}/${a.model}: ${a.error.slice(0, 90)}`);
  } else {
    line("Proposal gen", true, `served by ${res.provider} (${res.model})`);
    console.log(`        reply: "${res.text.slice(0, 40)}"`);
    for (const a of res.attempts) {
      console.log(`        skipped ${a.provider}/${a.model}: ${a.error.slice(0, 80)}`);
    }
  }
}
console.log("");
