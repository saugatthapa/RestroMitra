// Loads .env.local (if present) so `npm test` can pick up DATABASE_URL for
// the integration tests in src/db/__tests__/. Safe to run with no .env.local
// at all — unit tests that don't touch the DB simply run without it, and
// DB-dependent integration tests skip themselves (see tenant-isolation.test.ts).
try {
  // Node 20.12+/22+: reads and applies a dotenv-format file to process.env.
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local yet — fine, DB-dependent tests will skip themselves.
}
