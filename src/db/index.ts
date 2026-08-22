import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill in your Supabase connection string.",
  );
}

// A small connection pool is fine for the app runtime (pooled/transaction
// mode connection string from Supabase). Migrations use a separate direct
// connection — see drizzle.config.ts / DIRECT_URL.
//
// In development, Next.js hot-reloads this module every time a file under
// src/db (or anything importing it) changes. Without caching the client
// across reloads, each reload opened a brand-new `postgres()` pool (up to
// `max` connections) while the previous pool's connections stayed open —
// nothing ever called `.end()` on the old one. A session of normal editing
// (dozens of reloads) was enough to exhaust Postgres's own
// `max_connections` entirely — confirmed live: `psql` itself couldn't
// connect anymore ("sorry, too many clients already"), not just the app.
// Stashing the client on `globalThis` in development makes HMR reuse the
// same pool instead of leaking a new one on every reload. Production never
// hits this: the module only loads once per long-lived process there.
declare global {
  // eslint-disable-next-line no-var
  var __restromitraDbClient: ReturnType<typeof postgres> | undefined;
}

const client =
  process.env.NODE_ENV === "production"
    ? postgres(connectionString, { prepare: false, max: 10 })
    : (globalThis.__restromitraDbClient ??= postgres(connectionString, { prepare: false, max: 10 }));

export const db = drizzle(client, { schema });
export type Database = typeof db;

/**
 * The type of the `tx` handle passed into a `db.transaction(async (tx) =>
 * ...)` callback. Distinct from `Database` — a transaction handle lacks
 * `$client` and its own `.transaction()` method — so helper functions that
 * are always called from inside an enclosing transaction (e.g.
 * src/lib/inventory.ts's ledger helpers) should take this type, not
 * `Database`, or they won't type-check against a real call site.
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
