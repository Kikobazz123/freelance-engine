/**
 * Telegram webhook: button presses and slash commands, delivered instantly.
 *
 * Replaces polling. The 5-minute poll cost ~6,000 runs a month and a press could
 * wait up to five minutes; the local watcher made it instant but only while the
 * PC was on, and a stale copy of it once swallowed five "I applied" taps. A
 * webhook needs a public HTTPS URL, which Vercel provides.
 *
 * Two checks before anything runs:
 *   1. the X-Telegram-Bot-Api-Secret-Token header must equal
 *      TELEGRAM_WEBHOOK_SECRET — Telegram sends it on every call once the
 *      webhook is registered with it, and nobody else knows it;
 *   2. the update must come from his own chat (TELEGRAM_CHAT_ID), so even a
 *      leaked URL and secret could not /resume a paused pipeline for someone
 *      else's bot conversation.
 *
 * It answers 200 at once and does the work afterwards with waitUntil: Telegram
 * re-delivers an update it considers unanswered, and "approve all" takes a
 * minute or two to send. Handlers are idempotent regardless.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { parseUpdate } from "../src/lib/telegram.js";
import { handleCallback } from "../src/lib/decisions.js";
import { handleCommand } from "../src/lib/commands.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function secretOk(got: string | string[] | undefined): boolean {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const g = Array.isArray(got) ? got[0] : got ?? "";
  if (!want || g.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(g), Buffer.from(want));
}

export async function processUpdate(update: unknown): Promise<string> {
  const { callback, command } = parseUpdate(update);
  const mine = String(process.env.TELEGRAM_CHAT_ID ?? "");
  if (callback) {
    if (callback.chatId !== undefined && String(callback.chatId) !== mine) return "ignored: other chat";
    const r = await handleCallback(callback);
    return `${callback.data} -> ${r.action}=${r.result}`;
  }
  if (command) {
    if (String(command.chatId) !== mine) return "ignored: other chat";
    return `${command.text} -> ${await handleCommand(command.text)}`;
  }
  return "ignored: nothing actionable";
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") { res.statusCode = 405; return res.end("POST only"); }
  if (!secretOk(req.headers["x-telegram-bot-api-secret-token"])) {
    res.statusCode = 401; return res.end("bad secret");
  }
  let update: unknown;
  try { update = JSON.parse(await readBody(req)); }
  catch { res.statusCode = 400; return res.end("bad json"); }

  res.statusCode = 200;
  res.end("ok");
  waitUntil(processUpdate(update).then(
    (r) => console.log(`telegram: ${r}`),
    (e) => console.error(`telegram handler failed: ${String((e as Error).message).slice(0, 200)}`),
  ));
}
