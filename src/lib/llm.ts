/**
 * Free-tier LLM with provider AND model failover.
 *
 *   groq -> gemini -> openrouter -> labelled stub
 *
 * Same architecture as lordgen-brightpath-dashboard's AI layer, and the same
 * hard-won rule: **advance on ANY failure, not only rate limits.** A retired model
 * name returns a non-retryable 404, and treating that as fatal strands a perfectly
 * healthy provider.
 *
 * Free-tier model churn is the normal case, not an edge case. On the first live
 * credential check, ALL THREE configured models were dead at once:
 *   - Groq had removed llama-3.3-70b-versatile entirely
 *   - gemini-2.5-flash-lite 404'd
 *   - the chosen OpenRouter :free model had become paid-only
 * All three keys were valid. So each provider carries a list of models, tried in
 * order, and the whole chain has to be exhausted before anything degrades to a stub.
 *
 * Order is by free allowance, not quality:
 *   Groq       30 req/min, 14,400/day, no card   <- covers the pipeline alone
 *   Gemini     Flash cut hard in 2026; Flash-Lite retains a usable quota
 *   OpenRouter :free pool, shared and frequently 429
 */

export type LlmResult = {
  text: string;
  provider: "groq" | "gemini" | "openrouter" | "stub";
  model: string;
  attempts: { provider: string; model: string; error: string }[];
};

const TIMEOUT_MS = 45_000;

/**
 * Model preferences, verified live. Env overrides are prepended, not replaced, so
 * a bad override cannot take the whole provider down.
 *
 * Deliberately excluded from Groq: openai/gpt-oss-120b and -20b. They return
 * HTTP 200 with an EMPTY content field (reasoning models surface output elsewhere),
 * which is worse than an error — it looks like success and yields a blank proposal.
 */
const MODELS = {
  groq: ["qwen/qwen3.8-27b", "groq/compound-mini", "groq/compound"],
  // "latest" aliases first: they track Google's current model and are the single
  // best defence against the churn described above.
  gemini: ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-flash-latest"],
  openrouter: [
    "deepseek/deepseek-v4-flash-0731:free",
    "z-ai/glm-5.2:free",
    "qwen/qwen3.8-27b:free",
  ],
};

async function post(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Groq and OpenRouter are both OpenAI-compatible, so they share a caller. */
async function openaiCompatible(
  endpoint: string, key: string, model: string, system: string, user: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const r = await post(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify({
      model, max_tokens: 700, temperature: 0.7,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const text = j.choices?.[0]?.message?.content?.trim();
  // An empty 200 is a failure, not a success. Throwing advances the chain.
  if (!text) throw new Error("empty completion (200 but no content)");
  return text;
}

async function gemini(key: string, model: string, system: string, user: string): Promise<string> {
  const r = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 1200, temperature: 0.7 },
      }),
    },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  const j = (await r.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  const c = j.candidates?.[0];
  const text = c?.content?.parts?.map((p) => p.text ?? "").join("").trim();
  if (!text) throw new Error(`empty completion (finishReason=${c?.finishReason ?? "none"})`);
  return text;
}

/** Env override first, then the verified defaults, de-duplicated. */
function modelsFor(provider: keyof typeof MODELS, envVar: string): string[] {
  const override = process.env[envVar];
  return [...new Set([...(override ? [override] : []), ...MODELS[provider]])];
}

export async function complete(system: string, user: string): Promise<LlmResult> {
  const attempts: { provider: string; model: string; error: string }[] = [];

  const chain = [
    {
      name: "groq" as const,
      key: process.env.GROQ_API_KEY,
      models: modelsFor("groq", "GROQ_MODEL"),
      run: (k: string, m: string) =>
        openaiCompatible("https://api.groq.com/openai/v1/chat/completions", k, m, system, user),
    },
    {
      name: "gemini" as const,
      key: process.env.GEMINI_API_KEY,
      models: modelsFor("gemini", "GEMINI_MODEL"),
      run: (k: string, m: string) => gemini(k, m, system, user),
    },
    {
      name: "openrouter" as const,
      key: process.env.OPENROUTER_API_KEY,
      models: modelsFor("openrouter", "OPENROUTER_MODEL"),
      run: (k: string, m: string) =>
        openaiCompatible("https://openrouter.ai/api/v1/chat/completions", k, m, system, user, {
          // OpenRouter asks for these on free models; absence can mean deprioritisation.
          "HTTP-Referer": `https://github.com/${IDENTITY.githubUser}`,
          "X-Title": "freelance-engine",
        }),
    },
  ];

  for (const p of chain) {
    if (!p.key) {
      attempts.push({ provider: p.name, model: "-", error: "no key configured" });
      continue;
    }
    for (const model of p.models) {
      try {
        const text = await p.run(p.key, model);
        return { text, provider: p.name, model, attempts };
      } catch (e) {
        // Never log the key. Record and keep going.
        attempts.push({
          provider: p.name, model,
          error: String((e as Error).message).slice(0, 160),
        });
      }
    }
  }

  return { text: "", provider: "stub", model: "none", attempts };
}

/**
 * Generate, validate, and retry once with the violations fed back.
 *
 * Adding a "NEVER NAME THESE" block to the system prompt barely moved the block
 * rate — a 27B open model does not reliably honour a long negative list. Naming
 * the specific offence it just committed works far better than asking it to
 * remember a list in advance, and one retry converts most rejections into sends
 * for the price of a second free-tier call.
 *
 * The validator stays authoritative: if the retry is also bad, the caller gets
 * the violations and refuses to send.
 */
export async function completeValidated(
  system: string,
  user: string,
  validate: (text: string) => { kind: string; found: string }[],
): Promise<LlmResult & { violations: { kind: string; found: string }[]; retried: boolean }> {
  const first = await complete(system, user);
  if (first.provider === "stub" || !first.text) {
    return { ...first, violations: [], retried: false };
  }

  const bad = validate(first.text);
  if (!bad.length) return { ...first, violations: [], retried: false };

  const correction = [
    user,
    ``,
    `---`,
    `Your previous draft was REJECTED for naming things this person has not used:`,
    ...bad.map((v) => `  - ${v.kind}: "${v.found}"`),
    ``,
    `Rewrite it. Remove those entirely — do not substitute a different unlisted`,
    `technology, and do not state any location other than Nigeria/remote. Keep`,
    `everything that was accurate.`,
  ].join("\n");

  const second = await complete(system, correction);
  if (second.provider === "stub" || !second.text) {
    return { ...first, violations: bad, retried: true };
  }

  return { ...second, violations: validate(second.text), retried: true };
}import { IDENTITY } from "../config.js";

