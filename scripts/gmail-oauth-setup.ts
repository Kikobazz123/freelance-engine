/**
 * LOCAL ONLY — one-time setup, not a deployed task.
 *
 * Mints a Gmail refresh token and writes it straight into .env.
 *
 * Adapted from the same script in trigger-demo, with one necessary change:
 * that one requests only `gmail.send`. This pipeline also READS the inbox
 * (inbox-watch classifies client replies), so it needs `gmail.readonly` too.
 * A send-only token authenticates fine and then 403s on every search.
 *
 * Writes the token to .env rather than printing it — keeps it out of terminal
 * scrollback and removes a copy-paste step that is easy to truncate.
 *
 *   npm run gmail-oauth-setup
 */

import "dotenv/config";
import { createServer, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PORT = 53_682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

// Both scopes. gmail.send alone cannot list or read messages.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
if (!clientId) throw new Error("GMAIL_CLIENT_ID is not set in .env");
if (!clientSecret) throw new Error("GMAIL_CLIENT_SECRET is not set in .env");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
// access_type=offline + prompt=consent is what makes Google return a REFRESH
// token rather than only an access token. Without prompt=consent it often
// returns none at all on a repeat authorisation.
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

function persist(token: string) {
  const path = ".env";
  const env = readFileSync(path, "utf8");
  const line = `GMAIL_REFRESH_TOKEN="${token}"`;
  const next = /^GMAIL_REFRESH_TOKEN=.*$/m.test(env)
    ? env.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, line)
    : env.trimEnd() + "\n" + line + "\n";
  writeFileSync(path, next, "utf8");
}

/**
 * Send the browser its final page, then wind the server down and let the event
 * loop drain on its own.
 *
 * Calling process.exit() here instead — in the same tick as server.close(),
 * while the response is still flushing — aborts on Windows with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and an exit code of
 * 127, which buries whichever code we meant to report. Waiting for "finish"
 * keeps the exit code meaningful: 0 only when both scopes came back.
 *
 * closeAllConnections() is what actually lets the process end — the browser
 * holds the socket open with keep-alive, and server.close() alone waits for it.
 */
function shutdown(res: ServerResponse, status: number, body: string, code: number) {
  process.exitCode = code;
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body, () => {
    server.closeAllConnections();
    server.close();
  });
}

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    console.error("Authorization failed:", error ?? "no code returned");
    shutdown(res, 400, `Authorization failed: ${error ?? "no code returned"}`, 1);
    return;
  }

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId!, client_secret: clientSecret!,
      redirect_uri: REDIRECT_URI, grant_type: "authorization_code",
    }),
  });

  const j = (await r.json()) as {
    refresh_token?: string; scope?: string; error?: string; error_description?: string;
  };

  if (!r.ok || !j.refresh_token) {
    // Print the error code only — the body can carry token material.
    console.error(`Token exchange failed: ${j.error ?? r.status} ${j.error_description ?? ""}`);
    console.error("If there is no refresh_token, revoke prior access at");
    console.error("https://myaccount.google.com/permissions and run this again.");
    shutdown(res, 500, "Token exchange failed.", 1);
    return;
  }

  persist(j.refresh_token);

  const granted = (j.scope ?? "").split(" ");
  const hasSend = granted.some((s) => s.endsWith("gmail.send"));
  const hasRead = granted.some((s) => s.endsWith("gmail.readonly") || s.endsWith("gmail.modify"));

  console.log("\nrefresh token written to .env");
  console.log(`  gmail.send     : ${hasSend ? "granted" : "MISSING — sending will fail"}`);
  console.log(`  gmail.readonly : ${hasRead ? "granted" : "MISSING — inbox-watch will 403"}`);
  console.log("\nverify with: tsx scripts/check-keys.ts");

  shutdown(res, 200, "Done. Refresh token written to .env. You can close this tab.", hasSend && hasRead ? 0 : 1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Opening browser for Google consent...");
  console.log("If it does not open, paste this URL yourself:\n");
  console.log(authUrl.toString() + "\n");
  exec(`start "" "${authUrl.toString()}"`, () => {});
});
