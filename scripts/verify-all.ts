/**
 * Run every verification suite and report all of them.
 *
 * This replaces a chain of `&&`, which had two problems on this machine:
 *
 *   1. Node on Windows intermittently trips a libuv assertion
 *      (!(handle->flags & UV_HANDLE_CLOSING)) while tearing down undici's
 *      keep-alive pool. That happens AFTER a suite has printed its results, so
 *      the assertions all passed and the exit code still said failure. Letting
 *      the process exit naturally instead costs ~30s per suite, which is why
 *      the suites call process.exit() in the first place.
 *
 *   2. `&&` stops at the first non-zero exit, so one flaky teardown hid the
 *      results of every suite after it.
 *
 * So the exit code is not the source of truth here — the printed result line
 * is. A suite passes only if it reported "N passed, 0 failed". A suite that
 * exits badly WITHOUT having reported is a real failure and is treated as one,
 * which is the case that actually matters.
 *
 *   tsx scripts/verify-all.ts
 */

import { spawnSync } from "node:child_process";

const SUITES = [
  "verify",
  "verify-extra",
  "verify-callbacks",
  "verify-lane-a",
  "verify-digest",
  "verify-discover",
  "verify-eligibility",
  "verify-kits",
  "verify-ranking",
];

type Result = {
  name: string; passed: number; failed: number;
  reported: boolean; code: number | null; crashed: boolean;
};

const results: Result[] = [];

for (const name of SUITES) {
  process.stdout.write(`${name.padEnd(18)} `);

  const r = spawnSync("npx", ["tsx", `scripts/${name}.ts`], {
    encoding: "utf8",
    shell: true,
    // Suites must never message his real chat; see TELEGRAM_DRY in telegram.ts.
    env: { ...process.env, TELEGRAM_DRY: "1" },
    timeout: 10 * 60_000,
  });

  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const crashed = /SUITE CRASHED/.test(out);

  const res: Result = {
    name,
    passed: m ? Number(m[1]) : 0,
    failed: m ? Number(m[2]) : 0,
    reported: Boolean(m),
    code: r.status,
    crashed,
  };
  results.push(res);

  if (!res.reported) {
    console.log(`NO RESULT  (exit ${r.status}) <- did not finish`);
    // Show why, or this is undebuggable.
    console.log(out.trim().split("\n").slice(-12).map((l) => `      ${l}`).join("\n"));
  } else if (res.failed || res.crashed) {
    console.log(`${res.passed} passed, ${res.failed} failed${res.crashed ? "  CRASHED" : ""}`);
    for (const l of out.split("\n").filter((l) => /^\s*FAIL\b|SUITE CRASHED/.test(l))) {
      console.log(`      ${l.trim()}`);
    }
  } else {
    const teardown = r.status !== 0 ? `  (exit ${r.status} at teardown, ignored)` : "";
    console.log(`${res.passed} passed${teardown}`);
  }
}

const bad = results.filter((r) => !r.reported || r.failed > 0 || r.crashed);
const total = results.reduce((n, r) => n + r.passed, 0);
const failed = results.reduce((n, r) => n + r.failed, 0);

console.log(`\n${total} assertions passed, ${failed} failed, across ${results.length} suites`);

if (bad.length) {
  console.log(`\nFAILING SUITES: ${bad.map((b) => b.name).join(", ")}`);
  process.exit(1);
}
console.log("all green");
process.exit(0);
