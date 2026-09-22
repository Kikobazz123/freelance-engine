import { Inngest } from "inngest";

/**
 * The Inngest client. In production it reads INNGEST_SIGNING_KEY (to verify
 * that calls to the serve endpoint really come from Inngest) and
 * INNGEST_EVENT_KEY (to send events) from the environment. Locally, with the
 * Inngest dev server running, neither is needed.
 */
export const inngest = new Inngest({ id: "freelance-engine" });
