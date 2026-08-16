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
const client = postgres(connectionString, { prepare: false, max: 10 });

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
