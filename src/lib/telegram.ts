/**
 * Telegram output and callback handling. Plain fetch against the Bot API — no SDK
 * needed for sending, inline keyboards and polling, and one less dependency in
 * every task bundle.
 */

const API = "https://api.telegram.org";

function creds() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");
  return { token, chatId };
}

export type Button = { text: string; callback_data: string };

async function call(method: string, body: Record<string, unknown> = {}) {
  const { token } = creds();
  const r = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await r.json()) as { ok: boolean; description?: string; result?: unknown };
  // Never log the token — it is in the URL, so the URL never gets logged either.
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? r.status}`);
  return json.result;
}

/** Telegram's MarkdownV2 reserves these; unescaped, a job title with a "." 400s. */
export function esc(s: string): string {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => "\\" + c);
}

export async function send(text: string, buttons?: Button[][]) {
  const { chatId } = creds();
  return (await call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  })) as { message_id: number; chat: { id: number } };
}

/**
 * Plain text escape hatch — for payloads that may contain unescapable junk.
 *
 * Takes optional buttons. The digest carries dozens of listing URLs, and every
 * one of them is a MarkdownV2 minefield (`-`, `.`, `(`, `_` all need escaping,
 * and one miss 400s the whole message). Telegram auto-links bare URLs in plain
 * text, so plain text gets clickable links with no escaping at all.
 */
export async function sendPlain(text: string, buttons?: Button[][]) {
  const { chatId } = creds();
  return (await call("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  })) as { message_id: number; chat: { id: number } };
}

/**
 * Edit a plain-text message, replacing its keyboard.
 *
 * Passing `buttons` as `[]` strips the keyboard entirely; passing a single
 * button replaces the row with just that one. Same no-escaping rationale as
 * sendPlain — a card that cannot be edited because of a stray full stop is a
 * card that lies about its own state.
 */
export async function editPlain(
  chatId: number, messageId: number, text: string, buttons: Button[][] = [],
) {
  return call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons },
  });
}

/**
 * One approval card per queued proposal.
 *
 * This is the compliance boundary. Upwork and Fiverr permanently ban tools that
 * submit without a human click, so nothing on a marketplace is ever sent by the
 * pipeline — the card hands over finished text and a link, and the user presses
 * Send on the platform themselves.
 *
 * Returns the message id so the callback handler can edit this exact card in
 * place once a decision is made.
 */
export async function approvalCard(p: {
  proposalId: number;
  title: string;
  company: string;
  source: string;
  score: number;
  rate: string;
  url: string;
  preview: string;
  market?: string;
  budgetNote?: string;
}): Promise<{ message_id: number; chat: { id: number } }> {
  const text = [
    `*${esc(p.title.slice(0, 90))}*`,
    `${esc(p.company || "—")} · ${esc(p.source)}`,
    `Fit *${p.score}* · Rate ${esc(p.rate)} · ${esc(p.market ?? "unknown")}`,
    ...(p.budgetNote ? [`_${esc(p.budgetNote)}_`] : []),
    ``,
    esc(p.preview.slice(0, 550)),
    ``,
    `[Open listing](${p.url})`,
    // Telegram expects answerCallbackQuery within ~10s, and the scheduled poller
    // runs every 5 minutes — so the button toast will usually never appear. Say
    // so on the card rather than letting a press look like it did nothing.
    `_Tap registers within 5 min \— run_ \`npm run approvals\` _for instant_`,
  ].join("\n");

  return send(text, [[
    { text: "✅ Approve", callback_data: `ap:${p.proposalId}` },
    { text: "✏️ Full text", callback_data: `ed:${p.proposalId}` },
    { text: "⏭ Skip", callback_data: `sk:${p.proposalId}` },
  ]]);
}

/* --------------------------------------------------------------- callbacks */

export type Callback = {
  id: string;
  data: string;
  messageId?: number;
  chatId?: number;
  from: string;
};

export type Command = { text: string; chatId: number };

/**
 * Acknowledge a button press. NEVER throws.
 *
 * Callback ids expire after a couple of minutes, and the scheduled poller can
 * pick a press up as much as five minutes late — so this call frequently fails
 * with "query is too old" through no fault of the decision being made.
 *
 * It used to throw. Because it runs first in approve(), that aborted everything
 * after it: the proposal was marked approved in the database, and then the card
 * edit and the full-text message never happened. The decision was recorded and
 * completely invisible, which is the worst of both.
 *
 * The toast is cosmetic. The card edit is the real feedback. A failure here must
 * not take the rest down with it.
 */
export async function answerCallback(id: string, text?: string, alert = false) {
  try {
    return await call("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text, show_alert: alert } : {}),
    });
  } catch (e) {
    console.warn(`answerCallback failed (non-fatal): ${String((e as Error).message).slice(0, 90)}`);
    return null;
  }
}

/** Rewrite a card in place once it is decided, so the chat shows current state. */
export async function editMessage(
  chatId: number, messageId: number, text: string, keepButtons = false,
) {
  return call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
    ...(keepButtons ? {} : { reply_markup: { inline_keyboard: [] } }),
  });
}

/**
 * Fetch pending updates from `offset` onward.
 *
 * Long-polls: Telegram holds the request open until something arrives or
 * `timeoutSec` elapses, so a 25s poll costs one request rather than 25 one-second
 * ones. Returns the new offset to persist — Telegram only drops an update once a
 * higher offset is acknowledged, so losing it means reprocessing everything.
 */
export async function getUpdates(offset: number, timeoutSec = 0): Promise<{
  callbacks: Callback[];
  commands: Command[];
  nextOffset: number;
}> {
  const result = (await call("getUpdates", {
    offset: offset > 0 ? offset : undefined,
    timeout: timeoutSec,
    allowed_updates: ["callback_query", "message"],
  })) as any[];

  const callbacks: Callback[] = [];
  const commands: Command[] = [];
  let next = offset;

  for (const u of result ?? []) {
    next = Math.max(next, u.update_id + 1);
    if (u.callback_query) {
      callbacks.push({
        id: u.callback_query.id,
        data: u.callback_query.data ?? "",
        messageId: u.callback_query.message?.message_id,
        chatId: u.callback_query.message?.chat?.id,
        from: u.callback_query.from?.username ?? String(u.callback_query.from?.id ?? "?"),
      });
    } else if (u.message?.text?.startsWith("/")) {
      commands.push({ text: u.message.text.trim(), chatId: u.message.chat.id });
    }
  }

  return { callbacks, commands, nextOffset: next };
}
