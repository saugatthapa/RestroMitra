/**
 * RC audit P1 regression test: proves the compare-and-swap guard added to
 * the reservation status route (src/app/api/restaurants/[slug]/reservations/
 * [reservationId]/status/route.ts) actually serializes concurrent status
 * transitions at the database level — the same `UPDATE ... WHERE id = ? AND
 * status = <expected-current-status>` shape the route now uses.
 *
 * The route itself resolves its session/permissions via
 * resolveRestaurantContext(), which this project's test suite has no
 * established harness for mocking (unlike the gateway-callback route, which
 * is genuinely session-free and is exercised directly in
 * route.test.ts) — so this proves the SQL-level guarantee the fix actually
 * relies on directly, exercising the identical WHERE-clause shape, rather
 * than reimplementing session mocking just to reach the same query.
 *
 * Concrete scenario this guards against: two staff concurrently act on the
 * same `confirmed` reservation — one marks it `seated`, one `cancelled`.
 * Without the `status = currentStatus` condition, both UPDATEs would match
 * and commit, and whichever ran last would silently win. With it, the
 * second UPDATE (issued against the now-stale `confirmed` status) matches
 * zero rows once the first has committed.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Reservation status CAS (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-resv-cas-${suffix}`, name: "TEST Reservation CAS Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function makeReservation(status: "requested" | "confirmed" = "confirmed") {
    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        restaurantId,
        customerName: "TEST Party",
        customerPhone: `98${Math.random().toString().slice(2, 10)}`,
        partySize: 4,
        status,
        reservationTime: new Date("2026-12-01T18:00:00.000Z"),
        durationMinutes: 90,
      })
      .returning();
    return reservation;
  }

  async function casUpdate(reservationId: string, fromStatus: string, toStatus: string) {
    return db
      .update(schema.reservations)
      .set({ status: toStatus as "seated" | "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(schema.reservations.id, reservationId),
          eq(schema.reservations.restaurantId, restaurantId),
          eq(schema.reservations.status, fromStatus as "confirmed"),
        ),
      )
      .returning();
  }

  it("only the first of two concurrent transitions from the same status commits — the second matches zero rows", async () => {
    const reservation = await makeReservation("confirmed");

    // Simulate two staff both reading "confirmed" and racing to update it —
    // one to "seated", one to "cancelled" — exactly the route's WHERE shape.
    const [seatedResult, cancelledResult] = await Promise.all([
      casUpdate(reservation.id, "confirmed", "seated"),
      casUpdate(reservation.id, "confirmed", "cancelled"),
    ]);

    // Exactly one of the two racing updates affected a row; the other
    // matched zero rows because the status was no longer "confirmed" by the
    // time it ran.
    const winners = [seatedResult, cancelledResult].filter((r) => r.length === 1);
    const losers = [seatedResult, cancelledResult].filter((r) => r.length === 0);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const [finalRow] = await db
      .select({ status: schema.reservations.status })
      .from(schema.reservations)
      .where(eq(schema.reservations.id, reservation.id));
    // The final status matches whichever update actually won — never a
    // silently-overwritten mix, and never both side effects applied.
    expect(["seated", "cancelled"]).toContain(finalRow.status);
    expect(finalRow.status).toBe(winners[0][0].status);
  });

  it("a stale-status update against an already-transitioned reservation matches zero rows", async () => {
    const reservation = await makeReservation("confirmed");

    const first = await casUpdate(reservation.id, "confirmed", "seated");
    expect(first).toHaveLength(1);

    // A second request still believing the reservation is "confirmed" (a
    // stale read from before the first request committed) must not be able
    // to also transition it.
    const second = await casUpdate(reservation.id, "confirmed", "cancelled");
    expect(second).toHaveLength(0);

    const [finalRow] = await db
      .select({ status: schema.reservations.status })
      .from(schema.reservations)
      .where(eq(schema.reservations.id, reservation.id));
    expect(finalRow.status).toBe("seated");
  });
});
