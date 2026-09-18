/**
 * Send an ad-hoc plain-text note to the Telegram chat.
 *
 *   tsx scripts/notify.ts "message text"
 *   echo "message text" | tsx scripts/notify.ts
 *
 * Plain text, not MarkdownV2 — an operational note should never fail to arrive
 * because a job title contained a full stop.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sendPlain } from "../src/lib/telegram.js";

const arg = process.argv.slice(2).join(" ").trim();
const text = arg || readFileSync(0, "utf8").trim();

if (!text) {
  console.error('usage: tsx scripts/notify.ts "message"   (or pipe it on stdin)');
  process.exit(1);
}

await sendPlain(text);
console.log(`sent ${text.length} chars to Telegram`);
