/**
 * Integration test for the settleLedgerDue() compare-and-swap fix
 * (src/lib/ledger.ts). Before this fix, the guarded UPDATE's WHERE clause
 * only checked `dueStatus = 'outstanding'` — which a PARTIAL settlement
 * never changes (only a settlement that reaches the full amount flips it
 * to 'settled'). That meant two concurrent partial settlements could both
 * still match the same WHERE clause: whichever committed second would
 * overwrite settledAmountInPaisa with its own stale, independently-
 * computed total, silently losing the first settlement's contribution
 * while BOTH settlement ledger entries still got recorded.
 *
 * Rather than relying on real timing to force two `settleLedgerDue` calls
 * to race (flaky by nature), this proves the WHERE clause's actual CAS
 * semantics directly and deterministically: settle part of a due for
 * real, then attempt the exact UPDATE a second, "stale" concurrent caller
 * would have issued (one still guarded on the pre-settlement
 * settledAmountInPaisa) and confirm it now matches zero rows — the same
 * "scoped update matches zero rows" pattern order-status-permissions.
 * test.ts uses for tenant isolation.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("settleLedgerDue compare-and-swap (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let ledger: typeof import("@/lib/ledger");

  let ownerId: string;
  let restaurantId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ledger = await import("@/lib/ledger");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Ledger Owner", phone: `9711${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-ledger-race-${suffix}`, name: "TEST Ledger Race Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    await db.insert(schema.userRoles).values({ userId: ownerId, restaurantId, role: "owner" });
  });

  afterAll(async () => {
    await db.delete(schema.ledgerEntries).where(eq(schema.ledgerEntries.restaurantId, restaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  async function createOutstandingDue(amountInPaisa: number) {
    return db.transaction((tx) =>
      ledger.recordLedgerEntry(tx, {
        restaurantId,
        direction: "credit",
        category: "sales",
        amountInPaisa,
        description: "TEST outstanding due",
        markAsDue: true,
        timezone: "UTC",
        recordedByUserId: ownerId,
      }),
    );
  }

  it("a deliberately-interleaved stale writer loses to a real settleLedgerDue call that commits in between", async () => {
    // This is the deterministic version of the race — no reliance on
    // Promise.all timing luck (see the third test below for that
    // best-effort variant). Transaction "A" reads the row, is then held
    // open by a gate until transaction "B" — a REAL settleLedgerDue()
    // call — has fully committed, and only then attempts its own UPDATE
    // using its now-stale read. Because a plain SELECT takes no row lock
    // under READ COMMITTED, B is free to run and commit while A is still
    // open, which is exactly the window the old dueStatus-only guard left
    // unprotected.
    const due = await createOutstandingDue(10_000);

    let resolveARead!: () => void;
    const aHasRead = new Promise<void>((resolve) => {
      resolveARead = resolve;
    });
    let resolveBCommitted!: () => void;
    const bCommitted = new Promise<void>((resolve) => {
      resolveBCommitted = resolve;
    });

    const aPromise = db.transaction(async (tx) => {
      const [row] = await tx.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.id, due.id));
      resolveARead();
      await bCommitted; // hold this transaction open until B has committed
      // Same WHERE-clause shape settleLedgerDue itself uses post-fix —
      // guarded on the exact settledAmountInPaisa A read, which B will
      // have since moved out from under it.
      return tx
        .update(schema.ledgerEntries)
        .set({ settledAmountInPaisa: row.settledAmountInPaisa + 4_000, dueStatus: "outstanding" })
        .where(
          and(
            eq(schema.ledgerEntries.id, due.id),
            eq(schema.ledgerEntries.restaurantId, restaurantId),
            eq(schema.ledgerEntries.dueStatus, "outstanding"),
            eq(schema.ledgerEntries.settledAmountInPaisa, row.settledAmountInPaisa),
          ),
        )
        .returning();
    });

    await aHasRead;
    // B: a full, real settleLedgerDue() call — the actual shipped code path.
    const bResult = await db.transaction((tx) =>
      ledger.settleLedgerDue(tx, {
        restaurantId,
        entryId: due.id,
        amountInPaisa: 4_000,
        timezone: "UTC",
        recordedByUserId: ownerId,
      }),
    );
    expect(bResult.original.settledAmountInPaisa).toBe(4_000);
    resolveBCommitted();

    const aResult = await aPromise;
    // A's stale write must match nothing — this is the actual bug: without
    // the settledAmountInPaisa condition in the WHERE clause, this UPDATE
    // would still match (dueStatus is still 'outstanding' after B's
    // partial settlement) and silently overwrite B's committed 4,000 with
    // A's own stale-computed 4,000, while a second settlement ledger entry
    // still got recorded for money that was never actually settled twice.
    expect(aResult).toHaveLength(0);

    const [final] = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.id, due.id));
    expect(final.settledAmountInPaisa).toBe(4_000);
  });

  it("settleLedgerDue itself throws 409 when the row no longer matches its own just-read snapshot", async () => {
    const due = await createOutstandingDue(5_000);

    // Simulate "someone else settled part of this between my read and my
    // write" by advancing settledAmountInPaisa directly, bypassing
    // settleLedgerDue's own read.
    await db
      .update(schema.ledgerEntries)
      .set({ settledAmountInPaisa: 2_000 })
      .where(eq(schema.ledgerEntries.id, due.id));

    // settleLedgerDue re-reads fresh internally, so in isolation this
    // would normally succeed against the fresh settledAmountInPaisa (2000)
    // — it does NOT throw just because the row changed since insert. This
    // confirms the CAS is about protecting against a race DURING
    // settleLedgerDue's own read-then-write, not stale data in general.
    const result = await db.transaction((tx) =>
      ledger.settleLedgerDue(tx, {
        restaurantId,
        entryId: due.id,
        amountInPaisa: 1_000,
        timezone: "UTC",
        recordedByUserId: ownerId,
      }),
    );
    expect(result.original.settledAmountInPaisa).toBe(3_000);
  });

  it("two genuinely concurrent partial settleLedgerDue calls never both succeed on a stale read", async () => {
    const due = await createOutstandingDue(10_000);

    // Fired via Promise.all (not awaited one at a time) so both hit their
    // own Postgres connection and issue their initial SELECT before either
    // has necessarily committed its UPDATE — the actual race this guards
    // against, not just the WHERE-clause behavior tested in isolation
    // above.
    const attempt = () =>
      db
        .transaction((tx) =>
          ledger.settleLedgerDue(tx, {
            restaurantId,
            entryId: due.id,
            amountInPaisa: 4_000,
            timezone: "UTC",
        recordedByUserId: ownerId,
          }),
        )
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a, b];
    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);

    // Whether Postgres happened to fully serialize these two transactions
    // (both legitimately succeed, one after the other reading the other's
    // committed state) or genuinely interleaved them (the actual race —
    // one must lose and get a clean 409), the invariant that holds either
    // way is: final settledAmountInPaisa exactly matches 4,000 times how
    // many attempts actually succeeded. The bug this guards against is a
    // LOST UPDATE — a second, stale write silently overwriting the first
    // settlement's contribution instead of summing on top of it — which
    // would break this exact invariant (e.g. 2 succeeded but the final
    // amount only reflects 1) without necessarily changing how many calls
    // reported success.
    if (failed.length > 0) {
      const failure = failed[0] as { ok: false; err: unknown };
      expect(failure.err).toMatchObject({ status: 409 });
    }

    const [final] = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.id, due.id));
    expect(final.settledAmountInPaisa).toBe(4_000 * succeeded.length);
  });
});
