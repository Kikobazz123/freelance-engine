/**
 * Contact-email extraction from listing text.
 *
 * Lane A only ever writes to an address the poster published *asking to be
 * contacted* — an HN "Who is hiring" comment saying "email jobs@acme.com". That
 * is answering an invitation, not unsolicited outreach, which is what makes the
 * lane safe to automate at all.
 *
 * Getting this wrong is expensive in a way most bugs are not: a bad address means
 * emailing a stranger who never asked. So the filters below are deliberately
 * aggressive, and anything uncertain is dropped rather than guessed.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Addresses that are never a hiring contact. */
const BLOCKED_LOCAL = [
  "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon",
  "postmaster", "abuse", "unsubscribe", "bounce", "notifications",
  "sentry", "webmaster", "privacy", "legal", "dpo", "security",
];

const BLOCKED_DOMAIN = [
  "example.com", "example.org", "domain.com", "yourcompany.com", "email.com",
  "sentry.io", "wixpress.com", "sentry-next.wixpress.com",
  "schema.org", "w3.org", "github.io",
];

/**
 * Free mail providers. A hiring contact at a real company uses a company domain;
 * a gmail.com address in a hiring thread is overwhelmingly a *job seeker*
 * advertising themselves. Those are competitors, not clients — emailing one is
 * both useless and embarrassing.
 */
const FREE_MAIL = [
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "live.com", "aol.com", "icloud.com", "me.com", "proton.me", "protonmail.com",
  "gmx.com", "mail.com", "yandex.com", "zoho.com",
];

/** Text that means "write to this address about the job". */
const INVITE_NEAR = /\b(email|e-mail|contact|apply|reach|send|write|cv|resume|résumé|inquiries|questions)\b/i;

export type Contact = { email: string; reason: string } | null;

/**
 * Pull a hiring contact out of a listing body, or return null.
 *
 * `allowFreeMail` stays false by default. It exists only so a future
 * Apollo-sourced path, where the address provenance is known, can opt in.
 */
export function extractContact(text: string, opts: { allowFreeMail?: boolean } = {}): Contact {
  if (!text) return null;
  const matches = text.match(EMAIL_RE);
  if (!matches) return null;

  for (const raw of matches) {
    const email = raw.toLowerCase().replace(/[.,;:)\]]+$/, "");
    const [local, domain] = email.split("@");
    if (!local || !domain) continue;

    if (BLOCKED_LOCAL.some((b) => local.startsWith(b))) continue;
    if (BLOCKED_DOMAIN.some((b) => domain === b || domain.endsWith("." + b))) continue;
    // A "+tag" is fine (talent+hn@ is a real pattern), but strip nothing — the
    // address must be used exactly as published.
    if (!opts.allowFreeMail && FREE_MAIL.includes(domain)) continue;
    // Image and asset filenames occasionally match the email shape.
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(domain)) continue;
    if (email.length > 120) continue;

    // Require the address to sit near language inviting contact. Without this an
    // address quoted for any other reason gets treated as an application target.
    const at = text.toLowerCase().indexOf(email);
    const window = text.slice(Math.max(0, at - 160), at + 80);
    if (!INVITE_NEAR.test(window)) continue;

    return { email, reason: `published in listing near contact language` };
  }
  return null;
}
