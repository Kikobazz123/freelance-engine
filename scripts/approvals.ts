/**
 * Supervisor for the local Telegram watcher.
 *
 *   npm run approvals
 *
 * The watcher answers button presses instantly, which is why it exists — and
 * that is also how it went wrong. It was started before apply kits were built,
 * kept running with the old code loaded in memory, and answered five "I
 * applied" taps with "unknown action". It beat the production poller to every
 * press, so none of the five was recorded.
 *
 * So this file imports nothing from the engine and can never be stale itself.
 * It runs scripts/approvals-worker.ts as a child process, and restarts it
 * whenever any engine source file changes on disk, or if it exits. The worker
 * always runs the code that is actually there.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WATCH = ["src", "scripts/approvals-worker.ts"];
const CHECK_MS = 5_000;

/** Newest modification time across every .ts file being watched. */
function newestMtime(): number {
  let newest = 0;
  const visit = (p: string) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) visit(join(p, e));
    } else if (p.endsWith(".ts")) {
      newest = Math.max(newest, st.mtimeMs);
    }
  };
  WATCH.forEach(visit);
  return newest;
}

let child: ChildProcess | null = null;
let loadedAt = 0;
let stopping = false;

function start(reason: string) {
  loadedAt = newestMtime();
  console.log(`[supervisor] ${new Date().toLocaleTimeString()} starting watcher (${reason})`);
  child = spawn("npx", ["tsx", "scripts/approvals-worker.ts"], { stdio: "inherit", shell: true });
  child.on("exit", (code) => {
    child = null;
    if (stopping) return;
    // Crashed or exited on its own: restart after a short pause, never give up.
    console.log(`[supervisor] watcher exited (code ${code}) — restarting in 3s`);
    setTimeout(() => !stopping && !child && start("previous run exited"), 3_000);
  });
}

function restart(reason: string) {
  if (!child) return start(reason);
  const old = child;
  child = null;
  old.removeAllListeners("exit");
  old.once("exit", () => !stopping && start(reason));
  // Windows has no SIGTERM for a shell-spawned tree; taskkill /T takes the child tsx with it.
  if (process.platform === "win32" && old.pid) {
    spawn("taskkill", ["/pid", String(old.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    old.kill("SIGTERM");
  }
}

setInterval(() => {
  if (stopping) return;
  if (newestMtime() > loadedAt) restart("engine code changed on disk");
}, CHECK_MS);

process.on("SIGINT", () => {
  stopping = true;
  console.log("\n[supervisor] stopping");
  if (child?.pid && process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else child?.kill("SIGINT");
  setTimeout(() => process.exit(0), 1_000);
});

start("launch");
