// Start the Inngest dev server against the local function endpoint.
// BASE_URL is read from the environment (or .env); see .env.example.
import "dotenv/config";
import { spawn } from "node:child_process";

const base = process.env.BASE_URL;
if (!base) {
  console.error("BASE_URL is not set. Copy .env.example to .env (it documents the default).");
  process.exit(1);
}

const url = `${base.replace(/\/$/, "")}/api/inngest`;
const child = spawn("npx", ["--yes", "inngest-cli@latest", "dev", "-u", url, "--no-discovery"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
