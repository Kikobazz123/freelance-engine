/**
 * Minimal Gmail REST client.
 *
 * Reuses the OAuth client already set up for trigger-demo — same client id and
 * secret, re-authorised here with an added `gmail.readonly` scope because this
 * pipeline reads the inbox as well as sending. Direct fetch rather than
 * googleapis keeps the Trigger.dev bundle small.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  // 60s safety margin so a token cannot expire mid-request.
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const client_id = process.env.GMAIL_CLIENT_ID;
  const client_secret = process.env.GMAIL_CLIENT_SECRET;
  const refresh_token = process.env.GMAIL_REFRESH_TOKEN;
  if (!client_id) throw new Error("GMAIL_CLIENT_ID is not set");
  if (!client_secret) throw new Error("GMAIL_CLIENT_SECRET is not set");
  if (!refresh_token) throw new Error("GMAIL_REFRESH_TOKEN is not set");

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: "refresh_token" }),
  });
  if (!r.ok) {
    // Never echo the body — it can contain token material.
    throw new Error(`Gmail token refresh failed: HTTP ${r.status}`);
  }
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function api(path: string, init: RequestInit = {}) {
  const token = await accessToken();
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Gmail ${path.split("?")[0]} failed: HTTP ${r.status}`);
  return r.json();
}

export async function gmailSearch(q: string): Promise<{ id: string; threadId: string }[]> {
  const j = (await api(`/messages?q=${encodeURIComponent(q)}&maxResults=20`)) as {
    messages?: { id: string; threadId: string }[];
  };
  return j.messages ?? [];
}

export async function gmailGet(id: string): Promise<{
  from: string; subject: string; snippet: string; threadId: string;
}> {
  const j = (await api(
    `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
  )) as {
    snippet: string; threadId: string;
    payload: { headers: { name: string; value: string }[] };
  };
  const h = (n: string) =>
    j.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
  return { from: h("from"), subject: h("subject"), snippet: j.snippet ?? "", threadId: j.threadId };
}

const CRLF = "\r\n";

/** Wrap base64 at 76 chars — some servers reject or mangle unbroken payloads. */
const b64 = (buf: Buffer) => buf.toString("base64").replace(/(.{76})/g, `$1${CRLF}`);

/**
 * Send a message, optionally with one attachment.
 *
 * `dryRun` short-circuits BEFORE the network call, so a dry run can never touch
 * the wire — the guard in db.ts is the first gate and this is the second, and
 * they are independent on purpose.
 */
export async function gmailSend(opts: {
  to: string;
  subject: string;
  body: string;
  from?: string;
  dryRun: boolean;
  attachment?: { filename: string; contentType: string; data: Buffer };
}): Promise<{ id: string; threadId: string } | null> {
  if (opts.dryRun) return null;

  const from = opts.from ?? process.env.GMAIL_SENDER;
  if (!from) throw new Error("GMAIL_SENDER is not set");

  // RFC 2047-encode a non-ASCII subject, or an em dash arrives as mojibake.
  const subject = /^[\x20-\x7E]*$/.test(opts.subject)
    ? opts.subject
    : `=?UTF-8?B?${Buffer.from(opts.subject, "utf8").toString("base64")}?=`;

  const bodyB64 = b64(Buffer.from(opts.body, "utf8"));
  let mime: string;

  if (opts.attachment) {
    const bnd = `bnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    mime = [
      `From: ${from}`,
      `To: ${opts.to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${bnd}"`,
      ``,
      `--${bnd}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      bodyB64,
      ``,
      `--${bnd}`,
      `Content-Type: ${opts.attachment.contentType}; name="${opts.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      b64(opts.attachment.data),
      ``,
      `--${bnd}--`,
    ].join(CRLF);
  } else {
    mime = [
      `From: ${from}`,
      `To: ${opts.to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      bodyB64,
    ].join(CRLF);
  }

  const raw = Buffer.from(mime).toString("base64url");
  return (await api("/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  })) as { id: string; threadId: string };
}
