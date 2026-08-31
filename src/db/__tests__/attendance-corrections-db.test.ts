/**
 * Phase 13 (Attendance overhaul, Track B) — integration test for the two
 * new mutation routes' underlying DB shapes: the correction route
 * (PATCH .../attendance/[recordId]) and the status-review route
 * (PATCH .../attendance/[recordId]/status).
 *
 * Neither route can be exercised end-to-end here — both depend on
 * resolveRestaurantContext()/cookies(), and this project has no
 * session-mocking harness (see attendance-photos-db.test.ts and this
 * repo's other *-db.test.ts files for the same limitation, documented
 * repeatedly across earlier phases). Instead, this file proves the DB-level
 * invariants each route relies on by running the EXACT same
 * transaction/update shape the route handler itself uses, against a real
 * Postgres connection.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("attendance corrections + status review (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let userId: string;
  let reviewerId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [staff] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Correction Staff", phone: `9757${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = staff.id;

    const [reviewer] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Correction Reviewer", phone: `9756${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    reviewerId = reviewer.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-corrections-${suffix}`, name: "TEST Corrections Restaurant", isActive: true })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;
  });

  afterAll(async () => {
    await db.delete(schema.attendanceCorrections).where(eq(schema.attendanceCorrections.restaurantId, restaurantId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, reviewerId));
  });

  describe("correction route's transaction shape", () => {
    it("updates the record AND inserts a matching before/after ledger row atomically", async () => {
      const originalClockIn = new Date("2026-08-01T09:00:00Z");
      const originalClockOut = new Date("2026-08-01T17:00:00Z");
      const [record] = await db
        .insert(schema.attendanceRecords)
        .values({
          restaurantId,
          userId,
          clockInAt: originalClockIn,
          clockOutAt: originalClockOut,
          note: "original note",
          status: "verified",
        })
        .returning();

      const nextClockIn = new Date("2026-08-01T09:15:00Z"); // corrected: actually clocked in 15 min later
      const nextClockOut = originalClockOut; // unchanged
      const nextNote = "corrected: forgot to clock out on time, confirmed with staff";
      const reason = "Staff member showed up 15 minutes later than recorded — confirmed via WhatsApp.";

      const updated = await db.transaction(async (tx) => {
        const [rec] = await tx
          .update(schema.attendanceRecords)
          .set({ clockInAt: nextClockIn, clockOutAt: nextClockOut, note: nextNote })
          .where(eq(schema.attendanceRecords.id, record.id))
          .returning();

        await tx.insert(schema.attendanceCorrections).values({
          attendanceRecordId: record.id,
          restaurantId,
          correctedByUserId: reviewerId,
          reason,
          previousClockInAt: originalClockIn,
          previousClockOutAt: originalClockOut,
          previousNote: "original note",
          newClockInAt: nextClockIn,
          newClockOutAt: nextClockOut,
          newNote: nextNote,
        });

        return rec;
      });

      expect(updated.clockInAt.getTime()).toBe(nextClockIn.getTime());
      expect(updated.note).toBe(nextNote);

      const [ledgerRow] = await db
        .select()
        .from(schema.attendanceCorrections)
        .where(eq(schema.attendanceCorrections.attendanceRecordId, record.id));
      expect(ledgerRow.reason).toBe(reason);
      expect(ledgerRow.previousClockInAt.getTime()).toBe(originalClockIn.getTime());
      expect(ledgerRow.newClockInAt.getTime()).toBe(nextClockIn.getTime());
      expect(ledgerRow.previousNote).toBe("original note");
      expect(ledgerRow.newNote).toBe(nextNote);
      expect(ledgerRow.correctedByUserId).toBe(reviewerId);
    });

    it("a correction never sets clockOutAt back to null, so it can never collide with the one-open-shift-per-user constraint", async () => {
      // Regression guard for the reasoning in the route's own comment: two
      // corrections on two DIFFERENT records for the same user, neither of
      // which ever nulls clockOutAt, must both succeed even though the
      // partial unique index only allows one row with clock_out_at IS NULL
      // per (user, restaurant) at a time.
      const [openRecord] = await db
        .insert(schema.attendanceRecords)
        .values({ restaurantId, userId, clockInAt: new Date("2026-08-02T09:00:00Z"), status: "verified" })
        .returning();

      const [closedRecord] = await db
        .insert(schema.attendanceRecords)
        .values({
          restaurantId,
          userId,
          clockInAt: new Date("2026-08-03T09:00:00Z"),
          clockOutAt: new Date("2026-08-03T17:00:00Z"),
          status: "verified",
        })
        .returning();

      // Correct the closed record's note only — clockOutAt stays set, so
      // this can't collide with openRecord's still-open shift.
      await db.transaction(async (tx) => {
        const [rec] = await tx
          .update(schema.attendanceRecords)
          .set({ note: "corrected note, times unchanged" })
          .where(eq(schema.attendanceRecords.id, closedRecord.id))
          .returning();
        await tx.insert(schema.attendanceCorrections).values({
          attendanceRecordId: closedRecord.id,
          restaurantId,
          correctedByUserId: reviewerId,
          reason: "Fixing a typo in the note.",
          previousClockInAt: closedRecord.clockInAt,
          previousClockOutAt: closedRecord.clockOutAt,
          previousNote: closedRecord.note,
          newClockInAt: closedRecord.clockInAt,
          newClockOutAt: closedRecord.clockOutAt,
          newNote: "corrected note, times unchanged",
        });
        return rec;
      });

      const [openAfter] = await db
        .select()
        .from(schema.attendanceRecords)
        .where(eq(schema.attendanceRecords.id, openRecord.id));
      expect(openAfter.clockOutAt).toBeNull(); // still the one legitimately open shift
    });
  });

  describe("status-review route's update shape", () => {
    // These use a CLOSED shift (clockOutAt set) throughout: the "correction"
    // describe block above deliberately leaves userId with one open shift on
    // this restaurant, and attendance_records_one_open_shift_per_user_unique
    // allows only one open row per (user, restaurant) at a time.
    it("moving to verified stamps reviewedByUserId/reviewedAt and clears reviewNote when none is given", async () => {
      const [record] = await db
        .insert(schema.attendanceRecords)
        .values({
          restaurantId,
          userId,
          clockInAt: new Date("2026-08-04T09:00:00Z"),
          clockOutAt: new Date("2026-08-04T17:00:00Z"),
          clockInPhotoObjectKey: "attendance-photos/x/y/clock_in/2026-08-04-token.jpg",
          status: "needs_review",
        })
        .returning();

      const [updated] = await db
        .update(schema.attendanceRecords)
        .set({ status: "verified", reviewedByUserId: reviewerId, reviewedAt: new Date(), reviewNote: null })
        .where(eq(schema.attendanceRecords.id, record.id))
        .returning();

      expect(updated.status).toBe("verified");
      expect(updated.reviewedByUserId).toBe(reviewerId);
      expect(updated.reviewedAt).not.toBeNull();
      expect(updated.reviewNote).toBeNull();
    });

    it("moving to rejected persists the required reviewNote", async () => {
      const [record] = await db
        .insert(schema.attendanceRecords)
        .values({
          restaurantId,
          userId,
          clockInAt: new Date("2026-08-05T09:00:00Z"),
          clockOutAt: new Date("2026-08-05T17:00:00Z"),
          clockInPhotoObjectKey: "attendance-photos/x/y/clock_in/2026-08-05-token.jpg",
          status: "needs_review",
        })
        .returning();

      const reviewNote = "Photo doesn't match this staff member's ID on file.";
      const [updated] = await db
        .update(schema.attendanceRecords)
        .set({ status: "rejected", reviewedByUserId: reviewerId, reviewedAt: new Date(), reviewNote })
        .where(eq(schema.attendanceRecords.id, record.id))
        .returning();

      expect(updated.status).toBe("rejected");
      expect(updated.reviewNote).toBe(reviewNote);
    });

    it("a review never touches clockInAt/clockOutAt/note — it's orthogonal to a correction", async () => {
      const clockInAt = new Date("2026-08-06T09:00:00Z");
      const clockOutAt = new Date("2026-08-06T17:00:00Z");
      const [record] = await db
        .insert(schema.attendanceRecords)
        .values({ restaurantId, userId, clockInAt, clockOutAt, note: "unrelated note", status: "needs_review" })
        .returning();

      const [updated] = await db
        .update(schema.attendanceRecords)
        .set({ status: "verified", reviewedByUserId: reviewerId, reviewedAt: new Date(), reviewNote: null })
        .where(eq(schema.attendanceRecords.id, record.id))
        .returning();

      expect(updated.clockInAt.getTime()).toBe(clockInAt.getTime());
      expect(updated.note).toBe("unrelated note");
    });
  });
});
