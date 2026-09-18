/**
 * Letter formatting for Lane A applications.
 *
 * The generated body is good but arrives bare: no greeting, no sign-off, no
 * letterhead. That reads as curt to someone opening it cold, whatever the
 * content says.
 *
 * What this deliberately does NOT do is reproduce a block business letter. A
 * recipient postal address and "Dear Sir or Madam" in an email to a startup CTO
 * reads as a 1998 mail-merge. The sender's location belongs in the signature,
 * which is also what CAN-SPAM wants, and that is where it stays.
 *
 * Emits multipart/alternative: an HTML letter for clients that render it, and a
 * clean plain-text version for those that do not. Both carry identical content.
 */

import { SENDER_NAME, SENDER_LOCATION } from "./outreach.js";
import { IDENTITY } from "../config.js";

const NAVY = "#1F3864";
const EMAIL = IDENTITY.email;
const PHONE = IDENTITY.phone;
const GITHUB = `github.com/${IDENTITY.githubUser}`;
const LINKEDIN = IDENTITY.linkedin;
const TITLE = IDENTITY.title;
const COMPANY = IDENTITY.company;

/**
 * Who to greet.
 *
 * A first name guessed from a mailbox is wrong often enough to be worse than no
 * name — "Dear Recruiting" from recruiting@ is a visible mistake. So: the company
 * where it is known, otherwise the domain, otherwise a neutral fallback. Every
 * branch produces something a human could plausibly have typed.
 */
export function salutationFor(company: string | null, email: string): string {
  const clean = (s: string) =>
    s.replace(/\s*\|.*$/, "").replace(/\s*\(.*?\)\s*/g, " ").trim();

  if (company && company.length > 1 && !/^HN:/i.test(company)) {
    const c = clean(company);
    if (c && c.length <= 40) return `Dear ${c} team,`;
  }

  const domain = email.split("@")[1] ?? "";
  const brand = domain
    .replace(/\.(com|io|ai|co|org|net|dev|app|xyz|consulting)(\.[a-z]{2})?$/i, "")
    .split(".").pop() ?? "";
  if (brand && brand.length > 1 && brand.length <= 24) {
    return `Dear ${brand.charAt(0).toUpperCase()}${brand.slice(1)} team,`;
  }
  return "Dear Hiring Team,";
}

const today = () =>
  new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** Escape for HTML, so a title containing & or < cannot break the layout. */
const h = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Inline CSS only, no flexbox, no external stylesheets — anything else is a
 * coin flip across Outlook, Gmail and Apple Mail.
 */
export function htmlLetter(salutation: string, body: string): string {
  body = stripFurniture(body);
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;">${h(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:620px;margin:0 auto;padding:28px 24px;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.55;color:#1a1a1a;">

  <div style="font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:23px;font-weight:bold;letter-spacing:-0.3px;color:${NAVY};">${h(SENDER_NAME)}</div>
    <div style="font-size:13px;color:${NAVY};margin-top:2px;">${h(TITLE)} &middot; ${h(COMPANY)}</div>
    <div style="font-size:11.5px;color:#555;margin-top:5px;">
      ${h(EMAIL)} &nbsp;&middot;&nbsp; ${h(PHONE)} &nbsp;&middot;&nbsp; ${h(SENDER_LOCATION)}
    </div>
    <div style="font-size:11.5px;color:#555;margin-top:2px;">
      ${h(GITHUB)} &nbsp;&middot;&nbsp; ${h(LINKEDIN)}
    </div>
  </div>

  <div style="border-bottom:2px solid ${NAVY};margin:12px 0 18px;"></div>

  <div style="font-size:12.5px;color:#666;font-family:Arial,Helvetica,sans-serif;margin-bottom:18px;">${today()}</div>

  <p style="margin:0 0 14px;">${h(salutation)}</p>

${paras}

  <p style="margin:20px 0 4px;">Kind regards,</p>
  <p style="margin:0;font-weight:bold;">${h(SENDER_NAME)}</p>
  <p style="margin:2px 0 0;font-size:13px;color:#555;">${h(TITLE)} &middot; ${h(COMPANY)}</p>

  <div style="border-top:1px solid #d8d8d8;margin-top:22px;padding-top:10px;font-size:11px;color:#888;font-family:Arial,Helvetica,sans-serif;">
    CV attached. Reply &ldquo;no thanks&rdquo; and I won't contact you again.
  </div>

</div>
</body></html>`;
}

/** Same letter, for clients that do not render HTML. */
export function textLetter(salutation: string, body: string): string {
  body = stripFurniture(body);
  return [
    SENDER_NAME,
    `${TITLE} · ${COMPANY}`,
    `${EMAIL} · ${PHONE} · ${SENDER_LOCATION}`,
    `${GITHUB} · ${LINKEDIN}`,
    "=".repeat(64),
    "",
    today(),
    "",
    salutation,
    "",
    body.trim(),
    "",
    "Kind regards,",
    SENDER_NAME,
    `${TITLE} · ${COMPANY}`,
    "",
    "—",
    `CV attached. Reply "no thanks" and I won't contact you again.`,
  ].join("\n");
}

/**
 * Remove letter furniture the model emits despite being told not to.
 *
 * The prompt says "no subject line, no greeting, no sign-off" and the model
 * still produced "Subject: ..." as the first
 * body line, and earlier a full signature block. Same lesson as the claim
 * validator: a negative instruction is a request, not a guarantee. Strip it.
 *
 * Runs before the letter wraps the body, so a duplicate can never reach a
 * recipient.
 */
export function stripFurniture(body: string): string {
  let t = body.trim();

  // A leading "Subject: ..." line.
  t = t.replace(/^\s*subject\s*:[^\n]*\n+/i, "");

  // A leading greeting — the letter supplies its own.
  t = t.replace(/^\s*(dear|hi|hello|hey|greetings)\b[^\n]{0,60}[,:]\s*\n+/i, "");

  // A trailing sign-off and anything after it.
  t = t.replace(
    /\n+\s*(kind regards|best regards|regards|sincerely|yours (sincerely|faithfully|truly)|best|thanks|thank you|cheers)\s*[,.]?\s*[\s\S]*$/i,
    "",
  );

  // A trailing em-dash signature block.
  t = t.replace(/\n+\s*[—–-]{1,3}\s*\n[\s\S]*$/, "");

  return t.trim();
}
