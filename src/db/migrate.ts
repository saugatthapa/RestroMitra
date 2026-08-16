/**
 * Programmatic migration runner using the same postgres.js driver as the
 * app itself (src/db/index.ts), rather than the `drizzle-kit migrate` CLI.
 *
 * Why this exists: in at least one sandboxed environment, the drizzle-kit
 * CLI's own migrate command hung indefinitely even though a direct
 * postgres.js connection to the same database succeeded immediately. This
 * script sidesteps whatever the CLI does differently and just runs the
 * generated SQL files in ./drizzle directly against DIRECT_URL/DATABASE_URL.
 *
 * Usage: npm run db:migrate
 */
import "./load-env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("Set DIRECT_URL or DATABASE_URL before running migrations.");
}

async function main() {
  const migrationClient = postgres(connectionString!, { max: 1 });
  const db = drizzle(migrationClient);
  console.log("Running migrations…");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");
  await migrationClient.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
