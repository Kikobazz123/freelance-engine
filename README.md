# freelance-engine

A daily pipeline that finds contract work, scores it, writes a tailored application
for each, and refuses to send anything it cannot substantiate.

Built by **[Lordmark Dorgu](https://github.com/Kikobazz123)** · MIT licensed ·
runs entirely on free tiers.

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
check("no POST to any marketplace domain", !marketplacePost.test(code));
```

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

## Stack

TypeScript · Trigger.dev (durable scheduled jobs) · Neon serverless Postgres ·
Gmail API · Telegram Bot API · Groq / Gemini / OpenRouter with provider *and* model
failover.

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
src/trigger/    nine scheduled tasks
scripts/        four verification suites, dry run, credential check
```

## Verification

```bash
npm run verify      # 57 assertions across four suites
npm run dry-run     # full pipeline, writes every artifact for review, sends nothing
npm run check       # live credential check against every provider
```

The suites are the point, not decoration. Bugs they caught before production:

- a `NOT NULL` column that would have crashed the first live send
- a double button-press spending two bids from a monthly budget of six
- a "veto" that scored 16 instead of 0
- a market filter that would have silently disabled the entire marketplace lane,
  because the highest-yield feed carries no location data

## Setup

```bash
npm install
cp .env.example .env              # fill in
cp src/config.example.ts src/config.ts   # your identity and verifiable work
npm run migrate
npm run check
npm run dry-run                   # read the output before going near live mode
```

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
