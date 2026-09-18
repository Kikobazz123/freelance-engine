/**
 * Identity and profile. Copy to `src/config.ts` and fill in your own.
 *
 * This file is the single source of truth for every claim the system makes. The
 * claim validator in src/lib/claims.ts checks generated text against it, so an
 * LLM cannot invent a technology or a location you did not list here.
 *
 * Be strict with VERIFIABLE_WORK. Anything you put here can end up in an email
 * to a real hiring manager, and you have to be able to defend it on a call.
 */

export const IDENTITY = {
  name: "Your Name",
  location: "Your City, Your Country",
  timezone: "UTC+0",
  githubUser: "your-github-handle",
  linkedin: "linkedin.com/in/your-handle",
  title: "AI Automation Engineer",
  company: "Your Practice",
};

/** Only things you can point at. Numbers beat adjectives every time. */
export const VERIFIABLE_WORK = `
- <Project name>, live at <url>. <What it does.> <Stack.> <Concrete numbers:
  routes, tests, stages, channels.>
- <Second project.> <Stack.> <Numbers.>
- <Paid client work, if any.>
`.trim();

/** State these plainly. A visible gap beats a bluff that fails on the call. */
export const HONEST_GAPS = `
- <Something a lot of postings ask for that you have not done.>
- <No published outcome metrics, if that is true.>
- <Years of experience, stated accurately.>
`.trim();

/**
 * Technologies you have NOT used. The validator rejects any generated message
 * naming one of these — add anything that appears often in your target postings
 * and that you would not want to claim.
 */
export const NEVER_CLAIM = [
  "aws", "azure", "gcp", "kubernetes", "terraform",
  "langchain", "pinecone", "hubspot", "salesforce",
  "kafka", "airflow", "tensorflow", "pytorch",
  "java", "rust", "django", "vue", "angular",
];

/**
 * Tools you do not build in but legitimately talk about — the problem you are
 * hired to fix. Mentioning a client's use of these is honest; claiming to build
 * in them is not, and the validator enforces that distinction.
 */
export const RESCUE_TOOLS = ["n8n", "zapier", "make.com", "airtable"];

export const RATE_FLOOR_HOURLY = 35;
