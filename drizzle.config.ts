import { defineConfig } from "drizzle-kit";

// Migrations run against the DIRECT (non-pooled) connection string.
// The app itself, at runtime, uses DATABASE_URL (the pooled/transaction
// mode connection) — see src/db/index.ts.
//
// `drizzle-kit generate` only reads the schema file and does not open a
// connection, so a placeholder is fine there. `drizzle-kit migrate`/`push`
// DO need a real DIRECT_URL/DATABASE_URL in the environment and will fail
// with a connection error (not silently succeed) if only the placeholder
// is present.
const directUrl =
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  "postgresql://placeholder:placeholder@localhost:5432/placeholder";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: directUrl,
  },
  strict: true,
  verbose: true,
});
