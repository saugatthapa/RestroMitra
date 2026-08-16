/**
 * Side-effect-only import: loads .env.local into process.env before any
 * other module in the same file reads it.
 *
 * Why this exists as its own file: ES module imports execute in source
 * order, top to bottom, before the rest of the importing module's body
 * runs. `src/db/index.ts` reads `process.env.DATABASE_URL` at import time
 * (module top level), so anything that wants a populated environment
 * before importing it — like migrate.ts/seed.ts — must load the env file
 * via an earlier `import` statement, not a same-file call after the
 * imports. Putting the load logic in its own module makes that ordering
 * explicit: `import "./load-env"` first, then everything else.
 *
 * Uses Node's built-in `process.loadEnvFile` (Node 20.6+) instead of the
 * `--env-file` CLI flag so this works identically via `tsx script.ts` on
 * every platform — the CLI-flag approach broke on Windows, where
 * `node_modules/.bin/tsx` is a POSIX shell shim, not a JS file, so
 * `node --env-file=... node_modules/.bin/tsx ...` fails there even though
 * it works fine on Linux/macOS.
 */
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local present — fine in environments where env vars are
  // injected directly (CI, hosting platforms) rather than via a file.
}
