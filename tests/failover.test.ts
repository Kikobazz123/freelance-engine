/**
 * Provider AND model failover in src/lib/llm.ts. The rule under test: advance on
 * ANY failure, not only rate limits, and only degrade to the stub once the whole
 * chain is exhausted. fetch is stubbed; nothing touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, completeValidated } from "../src/lib/llm.js";

const KEYS = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "GROQ_MODEL", "GEMINI_MODEL", "OPENROUTER_MODEL"];

const openai = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const geminiOk = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
const fail = (status: number) => new Response("nope", { status });

const providerOf = (url: string) =>
  url.includes("groq.com") ? "groq" : url.includes("googleapis.com") ? "gemini" : "openrouter";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of KEYS) vi.stubEnv(k, "");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("complete", () => {
  it("returns the labelled stub without any network call when no key is set", async () => {
    const r = await complete("sys", "user");
    expect(r).toMatchObject({ provider: "stub", text: "", model: "none" });
    expect(r.attempts.map((a) => a.error)).toEqual(Array(3).fill("no key configured"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the first provider that answers", async () => {
    vi.stubEnv("GROQ_API_KEY", "k");
    fetchMock.mockResolvedValue(openai("hello"));
    const r = await complete("sys", "user");
    expect(r).toMatchObject({ provider: "groq", text: "hello" });
    expect(r.attempts).toEqual([]);
  });

  it("tries every model of a provider before moving on, then falls over to the next", async () => {
    vi.stubEnv("GROQ_API_KEY", "k");
    vi.stubEnv("GEMINI_API_KEY", "k");
    fetchMock.mockImplementation(async (url: string) =>
      providerOf(url) === "groq" ? fail(429) : geminiOk("from gemini"));

    const r = await complete("sys", "user");
    expect(r.provider).toBe("gemini");
    expect(r.text).toBe("from gemini");
    const groqTries = r.attempts.filter((a) => a.provider === "groq");
    expect(groqTries.length).toBe(3);
    expect(groqTries.every((a) => a.error.startsWith("HTTP 429"))).toBe(true);
  });

  it("advances on a non-retryable error such as a retired model's 404", async () => {
    vi.stubEnv("GROQ_API_KEY", "k");
    fetchMock.mockResolvedValueOnce(fail(404)).mockResolvedValueOnce(openai("second model"));
    const r = await complete("sys", "user");
    expect(r.text).toBe("second model");
    expect(r.attempts).toHaveLength(1);
  });

  it("treats an empty 200 as a failure, not a success", async () => {
    vi.stubEnv("GROQ_API_KEY", "k");
    fetchMock.mockResolvedValueOnce(openai("   ")).mockResolvedValueOnce(openai("real text"));
    const r = await complete("sys", "user");
    expect(r.text).toBe("real text");
    expect(r.attempts[0].error).toMatch(/empty completion/);
  });

  it("degrades to the stub only once every provider and model has failed", async () => {
    for (const k of ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) vi.stubEnv(k, "k");
    fetchMock.mockImplementation(async () => fail(500));
    const r = await complete("sys", "user");
    expect(r.provider).toBe("stub");
    expect(r.attempts).toHaveLength(9);
  });

  it("puts an env model override first without dropping the defaults", async () => {
    vi.stubEnv("GROQ_API_KEY", "k");
    vi.stubEnv("GROQ_MODEL", "custom/model");
    fetchMock.mockResolvedValueOnce(fail(404)).mockResolvedValueOnce(openai("ok"));
    const r = await complete("sys", "user");
    expect(r.attempts[0].model).toBe("custom/model");
    expect(r.model).not.toBe("custom/model");
  });

  it("never records the API key in attempt errors", async () => {
    vi.stubEnv("GEMINI_API_KEY", "super-secret-key");
    fetchMock.mockImplementation(async () => fail(403));
    const r = await complete("sys", "user");
    expect(JSON.stringify(r.attempts)).not.toContain("super-secret-key");
  });
});

describe("completeValidated", () => {
  const validate = (text: string) => (text.includes("AWS") ? [{ kind: "tech", found: "AWS" }] : []);

  beforeEach(() => vi.stubEnv("GROQ_API_KEY", "k"));

  it("returns a clean first draft without retrying", async () => {
    fetchMock.mockResolvedValue(openai("clean draft"));
    const r = await completeValidated("sys", "user", validate);
    expect(r).toMatchObject({ text: "clean draft", violations: [], retried: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once with the violations fed back, and returns the corrected draft", async () => {
    fetchMock.mockResolvedValueOnce(openai("I know AWS")).mockResolvedValueOnce(openai("clean rewrite"));
    const r = await completeValidated("sys", "user", validate);
    expect(r).toMatchObject({ text: "clean rewrite", violations: [], retried: true });
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondBody.messages[1].content).toMatch(/REJECTED[\s\S]*tech: "AWS"/);
  });

  it("keeps the validator authoritative when the retry is also bad", async () => {
    fetchMock.mockResolvedValue(openai("still AWS"));
    const r = await completeValidated("sys", "user", validate);
    expect(r.retried).toBe(true);
    expect(r.violations).toEqual([{ kind: "tech", found: "AWS" }]);
  });

  it("does not validate or retry a stub result", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const r = await completeValidated("sys", "user", validate);
    expect(r).toMatchObject({ provider: "stub", retried: false, violations: [] });
  });
});
