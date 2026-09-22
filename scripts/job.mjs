/**
 * Run one deployed job on demand and wait for the result.
 *
 *   npm run job -- harvest
 *   npm run job -- github-sync
 *
 * Sends the manual/run event to Inngest, then polls that event's runs until it
 * finishes. Verifying against the real deployment is how the github-sync bug
 * was found: it failed nightly in production while working locally.
 */
import "dotenv/config";

const job = process.argv[2];
if (!job) { console.error("usage: npm run job -- <job-id>"); process.exit(2); }

const key = process.env.INNGEST_EVENT_KEY;
if (!key) { console.error("INNGEST_EVENT_KEY is not set"); process.exit(2); }

const send = await fetch(`https://inn.gs/e/${key}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "manual/run", data: { job } }),
});
const sent = await send.json().catch(() => ({}));
if (!send.ok) { console.error(`send failed: ${send.status} ${JSON.stringify(sent)}`); process.exit(1); }
const id = sent.ids?.[0];
console.log(`sent manual/run job=${job} (event ${id})`);

const auth = { Authorization: `Bearer ${process.env.INNGEST_SIGNING_KEY}` };
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const r = await fetch(`https://api.inngest.com/v1/events/${id}/runs`, { headers: auth });
  if (!r.ok) { if (i === 0) console.log(`  (runs API ${r.status}; still waiting)`); continue; }
  const runs = (await r.json()).data ?? [];
  const run = runs[0];
  if (!run) continue;
  if (["Completed", "Failed", "Cancelled"].includes(run.status)) {
    console.log(`${run.status}: ${JSON.stringify(run.output ?? run.error ?? {}).slice(0, 500)}`);
    process.exit(run.status === "Completed" ? 0 : 1);
  }
}
console.log("still running after 6 minutes — check https://app.inngest.com");
