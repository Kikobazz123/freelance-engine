/**
 * The Inngest endpoint. Inngest calls this URL to discover the functions and
 * to run each scheduled job. In production it verifies every call with
 * INNGEST_SIGNING_KEY, so nobody else can trigger a job by hitting the URL.
 */
import { serve } from "inngest/node";
import { inngest } from "../src/inngest/client.js";
import { functions } from "../src/inngest/functions.js";

export default serve({ client: inngest, functions, servePath: "/api/inngest" });
