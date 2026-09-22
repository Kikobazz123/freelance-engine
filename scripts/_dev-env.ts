// Imported FIRST by scripts/dev-server.ts. ES modules evaluate imports in
// order, so this runs before the Inngest client is constructed — which is what
// lets `npm run dev:functions` work on Windows, where `INNGEST_DEV=1 cmd`
// syntax does not exist.
process.env.INNGEST_DEV ??= "1";
export {};
