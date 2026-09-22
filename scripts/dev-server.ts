/**
 * Serve the Vercel functions locally, exactly as deployed.
 *
 *   tsx scripts/dev-server.ts          then, in another terminal:
 *   npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
 *
 * The Inngest dev server needs no account: it discovers the functions, shows
 * them at http://localhost:8288, and can run any of them on demand.
 */
import "./_dev-env.js";
import "dotenv/config";
import { createServer } from "node:http";
import inngestHandler from "../api/inngest.js";
import telegramHandler from "../api/telegram.js";

const PORT = Number(process.env.PORT ?? 3000);

createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/api/inngest") return inngestHandler(req, res);
  if (path === "/api/telegram") return void telegramHandler(req, res);
  res.statusCode = 404;
  res.end("not found");
}).listen(PORT, () => console.log(`serving /api/inngest and /api/telegram on :${PORT}`));
