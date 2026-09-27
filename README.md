# freelance-engine

A daily pipeline that finds contract work, scores it, writes a tailored application
for each, and refuses to send anything it cannot substantiate.

[![CI](https://github.com/Kikobazz123/freelance-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/Kikobazz123/freelance-engine/actions/workflows/ci.yml)

Built by **[Lordmark Dorgu](https://github.com/Kikobazz123)** · MIT licensed ·
runs entirely on free tiers.

<!-- TODO: add screenshot (a Telegram approval card works well) -->

---

## The problem it solves

Applying to contract work at volume produces one of two failures. Do it by hand and
you manage maybe five a day. Automate it naively and you send generic text that gets
deleted, or — worse — an LLM writes something confident and false and you find out
on the call.

This handles both, and treats the second as the harder problem.

## Two lanes, and why the distinction matters

| Lane | Sources | Behaviour |
|---|---|---|
| **auto** | Postings that publish a contact address asking applicants to write | Sends a tailored application with CV attached |
| **approve** | Upwork, Fiverr, Freelancer, Contra | **Queues to Telegram. A human presses Send on the platform.** |

Upwork's terms permanently ban tools that submit a proposal without a human click,
and detection covers browser bots, headless automation and unauthorised API
submission. So **there is deliberately no code path in this repository that posts to
a marketplace**, and a test asserts that structurally rather than by policy:

```ts
it("has no POST to any marketplace domain", () => {
  expect(marketplacePost.test(code)).toBe(false);
});
```

The scan covers `src/` and `api/`, and a control case proves the pattern actually
fires on a real `fetch(url, { method: "POST" })`. (It did not always: see
[Tests](#tests).)

Lane A is narrower than it looks. It writes only to an address the poster published
*asking to be contacted* — answering an invitation, not cold outreach. That
distinction is what makes the lane reasonable to automate at all.

## The interesting part: the model does not get to make claims

An LLM writing job applications will, given the chance, claim whatever the posting
asks for. Two real examples from the first dry run, both lifted from the *posting*
rather than the author's profile:

```
"My stack matches your requirements: React, TypeScript, Python, FastAPI,
 and LangChain"                      <- had never used LangChain
"I am remote and available for full-time work in NYC"
                                     <- was on another continent
```

Either collapses on the first call. Adding a "never claim these" block to the system
prompt barely helped — a 27B open model does not reliably honour a long negative list
stated in advance.

So generation is split the way a scoring system should be: **the model produces,
deterministic code decides.**

`src/lib/claims.ts` checks every generated message against an explicit config, and a
violation blocks the send exactly like an empty response. On violation the system
re-prompts once with the specific offence named, which converts most rejections into
clean sends. Blocks dropped from 3-in-9 to 1-in-9, and the one that remains is a
posting so AWS-centric that refusing is correct.

It also draws a distinction that a simple deny-list gets wrong: saying **a client
uses n8n** and you replace it with code is honest and is the entire pitch; claiming
**you build in n8n** is not. Those are separated by context, not by keyword.

## Seven gates before anything reaches a stranger

```
1. guard()            dry-run / enabled, checked in BOTH the database and env
2. suppression        anyone who asked not to be contacted
3. one-per-address    a unique database index, not just a query
4. daily cap          bounded blast radius if anything upstream misfires
5. no stubs           an unreachable LLM must not produce an empty email
6. claim validation   nothing the profile cannot substantiate
7. dryRun             short-circuits before the network, independently
```

Env vars override the database **in the safe direction only**: they can force a
halt, they can never switch sending on. A stale `DRY_RUN=false` in a shell cannot
start live sending by itself.

## Scoring

Deterministic, 0–100, run before any LLM call so expensive per-listing tailoring only
sees the top slice. Weights stack match, channel, rate, freshness and client market.

Vetoes are **early returns, not large negative numbers**. Subtracting 100 looked
equivalent and was not: a listing scoring 116 came out at 16 after its "veto" and only
reached zero via the final clamp. Nudge any weight and fraud clears the skip line.

## Client-market targeting

Clients are tiered by paying power, measured rather than assumed. Over 1,103 real
listings: 53% tier 1, 4% tier 2, 0.8% vetoed, 42% unknown — and all vetoes were
correct on manual inspection.

Three rules keep it honest:

1. **Unknown is never vetoed.** 42% of listings state no location, and vetoing those
   would gut the funnel.
2. **Conflicting signals resolve to unknown.** A US/Canada remote post that happens
   to mention another country is ambiguous, not disqualified.
3. **Feed-level inference is marked low confidence.** Tagging every post from one
   board with that board's typical market covers a lot of the corpus on an
   assumption, so it earns a smaller weight than a currency symbol.

## The letter

Applications go out as a formatted letter, not a bare paragraph: letterhead,
date, salutation, body, sign-off, signature, with the CV attached. Sent as
`multipart/alternative` so clients that do not render HTML get an identical
plain-text version.

Deliberately not a block business letter — a recipient postal address by email
reads as a mail merge. And the salutation uses the company, never a first name
guessed from the mailbox: "Dear Recruiting" from `recruiting@` is a visible
mistake, and no name beats a wrong one.

`stripFurniture()` removes any subject line, greeting or sign-off the model emits
anyway. A negative instruction in a prompt is a request, not a guarantee.

## Stack

TypeScript · Inngest (cron schedules with retries) served from Vercel functions ·
Neon serverless Postgres · Gmail API · Telegram Bot API · Groq / Gemini / OpenRouter
with provider *and* model failover · Vitest · GitHub Actions.

Scheduling moved from Trigger.dev to Inngest because the Trigger.dev free plan
capped runs at about 5,000 a month and the old 5-minute Telegram poll alone used
~6,000. Telegram button presses now arrive at a webhook instead of being polled.
The job bodies in `src/jobs/` did not change; only the clock around them did.

Free-tier model churn is treated as the normal case, not an edge case. On one
credential check all three configured models were dead simultaneously while all three
keys were valid, so each provider carries a list and the chain advances on **any**
failure, not only rate limits.

## Layout

```
src/lib/
  claims.ts     claim validation - the model produces, code decides
  geo.ts        client-market detection and tiering
  scoring.ts    deterministic 0-100 fit scoring
  sources.ts    source registry and normalisation
  contact.ts    contact extraction, aggressively filtered
  llm.ts        provider + model failover, validate-and-retry
  db.ts         Neon access, pipeline state, guard, bid budget
  gmail.ts      Gmail REST with MIME attachments
  telegram.ts   Bot API, approval cards, callbacks
  decisions.ts  approve / skip, idempotent under redelivery
src/jobs/       the job bodies (harvest, score, generate, dispatch, send, ...)
src/inngest/    the schedules: one cron per job, plus a heartbeat per run
api/            Vercel functions: the Inngest endpoint and the Telegram webhook
src/trigger/    the earlier Trigger.dev task wrappers around the same jobs
tests/          Vitest unit tests (no network, no database)
scripts/        integration suites against a real database, dry run, ops tools
```

## Tests

```bash
npm test            # Vitest: scoring, eligibility, market tiers, claim validation,
                    # contact discovery, the marketplace boundary, LLM failover
npm run lint
npm run typecheck
```

These need no network, database or keys: `fetch` is stubbed for the failover
tests, and the gitignored `src/config.ts` resolves to `src/config.example.ts`.
CI runs lint, typecheck and tests on every push.

```bash
npm run verify      # six integration suites against a real Neon database
npm run dry-run     # full pipeline, writes every artifact for review, sends nothing
npm run check       # live credential check against every provider
```

The integration suites cover what a unit test cannot: the send guard read from the
database, idempotent Telegram callbacks, bid spending, batch release. They run with
`TELEGRAM_DRY=1` and `TEST_MODE=1`, so they never message the real chat or send mail.

The suites are the point, not decoration. Bugs they caught before production:

- a `NOT NULL` column that would have crashed the first live send
- a double button-press spending two bids from a monthly budget of six
- a "veto" that scored 16 instead of 0
- a market filter that would have silently disabled the entire marketplace lane,
  because the highest-yield feed carries no location data
- an env-var upload that reported success while writing to the wrong environment,
  so every deployed run failed on a missing `DATABASE_URL` while the check said
  all eleven variables were present
- a callback acknowledgement that threw on expired ids, aborting the card update
  *after* the decision had already been committed — recorded and invisible
- a test that restored the pipeline to "safe" so aggressively it silently
  disarmed a deliberately live deployment
- the marketplace-POST check itself: its regex expected `fetch(url), {...}`, a
  shape no real call has, so it could never fail. Porting it to Vitest with a
  control case exposed that; the pattern now matches real calls

## Setup

```bash
npm install
cp .env.example .env              # fill in
cp src/config.example.ts src/config.ts   # your identity and verifiable work
npm run migrate
npm run check
npm run dry-run                   # read the output before going near live mode
```

To run the scheduled functions locally, serve them with `npx tsx scripts/dev-server.ts`
and, in a second terminal, `npm run dev:inngest`. That points the Inngest dev server
at `$BASE_URL/api/inngest`; the default is in `.env.example`.

`src/config.ts` is the single source of truth for every claim. Be strict with it —
anything in it can end up in an email to a real hiring manager.

## Status

A working system, built for one person's job search and shared because the
architecture is reusable. It is a snapshot rather than a maintained product: expect
to adapt the source registry and the profile to your own situation.

Contributions and questions welcome via issues.

---

MIT © 2026 Lordmark Dorgu. If you use this, the licence asks only that you keep the
copyright notice — a link back is appreciated but not required.
