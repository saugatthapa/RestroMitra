/**
 * Phase 14 (Attendance overhaul, Track B) — integration test for the
 * leave-requests and holidays routes' underlying DB shapes. Same
 * limitation as attendance-corrections-db.test.ts: these routes depend on
 * resolveRestaurantContext()/cookies(), so they can't be exercised
 * end-to-end here (no session-mocking harness) — instead this proves the
 * exact query/transaction shapes each route relies on, against a real
 * Postgres connection.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { leaveRangesOverlap } from "@/lib/leave";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("leave requests + holidays (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let reviewerId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [staff] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Leave Staff", phone: `9755${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = staff.id;

    const [reviewer] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Leave Reviewer", phone: `9754${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    reviewerId = reviewer.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-leave-${suffix}`, name: "TEST Leave Restaurant", isActive: true })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Leave Branch" })
      .returning({ id: schema.branches.id });
    branchId = branch.id;
  });

  afterAll(async () => {
    await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.restaurantId, restaurantId));
    await db.delete(schema.holidays).where(eq(schema.holidays.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, reviewerId));
  });

  describe("leave-requests POST's overlap-check query", () => {
    it("finds a real overlap against an existing pending request", async () => {
      await db.insert(schema.leaveRequests).values({
        restaurantId,
        userId,
        leaveType: "casual",
        startDate: "2026-09-10",
        endDate: "2026-09-12",
        status: "pending",
      });

      // Same coarse window the route's GET-before-insert check runs, then
      // the exact leaveRangesOverlap filter in JS.
      const candidateStart = "2026-09-12";
      const candidateEnd = "2026-09-15";
      const rows = await db
        .select({ startDate: schema.leaveRequests.startDate, endDate: schema.leaveRequests.endDate })
        .from(schema.leaveRequests)
        .where(
          and(
            eq(schema.leaveRequests.restaurantId, restaurantId),
            eq(schema.leaveRequests.userId, userId),
            inArray(schema.leaveRequests.status, ["pending", "approved"]),
            gte(schema.leaveRequests.endDate, candidateStart),
            lte(schema.leaveRequests.startDate, candidateEnd),
          ),
        );
      const conflict = rows.some((r) => leaveRangesOverlap(r.startDate, r.endDate, candidateStart, candidateEnd));
      expect(conflict).toBe(true);
    });

    it("does not flag a non-overlapping request as a conflict", async () => {
      const candidateStart = "2026-10-01";
      const candidateEnd = "2026-10-03";
      const rows = await db
        .select({ startDate: schema.leaveRequests.startDate, endDate: schema.leaveRequests.endDate })
        .from(schema.leaveRequests)
        .where(
          and(
            eq(schema.leaveRequests.restaurantId, restaurantId),
            eq(schema.leaveRequests.userId, userId),
            inArray(schema.leaveRequests.status, ["pending", "approved"]),
            gte(schema.leaveRequests.endDate, candidateStart),
            lte(schema.leaveRequests.startDate, candidateEnd),
          ),
        );
      const conflict = rows.some((r) => leaveRangesOverlap(r.startDate, r.endDate, candidateStart, candidateEnd));
      expect(conflict).toBe(false);
    });

    it("ignores a rejected/cancelled request when checking for conflicts", async () => {
      await db.insert(schema.leaveRequests).values({
        restaurantId,
        userId,
        leaveType: "sick",
        startDate: "2026-11-01",
        endDate: "2026-11-03",
        status: "rejected",
      });

      const candidateStart = "2026-11-01";
      const candidateEnd = "2026-11-03";
      const rows = await db
        .select({ startDate: schema.leaveRequests.startDate, endDate: schema.leaveRequests.endDate })
        .from(schema.leaveRequests)
        .where(
          and(
            eq(schema.leaveRequests.restaurantId, restaurantId),
            eq(schema.leaveRequests.userId, userId),
            inArray(schema.leaveRequests.status, ["pending", "approved"]), // rejected excluded by this filter
            gte(schema.leaveRequests.endDate, candidateStart),
            lte(schema.leaveRequests.startDate, candidateEnd),
          ),
        );
      expect(rows.length).toBe(0);
    });
  });

  describe("review + cancel update shapes", () => {
    it("approving stamps reviewedByUserId/reviewedAt and leaves reviewNote null", async () => {
      const [record] = await db
        .insert(schema.leaveRequests)
        .values({ restaurantId, userId, leaveType: "casual", startDate: "2026-12-01", endDate: "2026-12-02" })
        .returning();

      const [updated] = await db
        .update(schema.leaveRequests)
        .set({ status: "approved", reviewedByUserId: reviewerId, reviewedAt: new Date(), reviewNote: null })
        .where(eq(schema.leaveRequests.id, record.id))
        .returning();

      expect(updated.status).toBe("approved");
      expect(updated.reviewedByUserId).toBe(reviewerId);
      expect(updated.reviewedAt).not.toBeNull();
    });

    it("rejecting persists the required reviewNote", async () => {
      const [record] = await db
        .insert(schema.leaveRequests)
        .values({ restaurantId, userId, leaveType: "unpaid", startDate: "2026-12-05", endDate: "2026-12-05" })
        .returning();

      const [updated] = await db
        .update(schema.leaveRequests)
        .set({
          status: "rejected",
          reviewedByUserId: reviewerId,
          reviewedAt: new Date(),
          reviewNote: "Short-staffed that week already.",
        })
        .where(eq(schema.leaveRequests.id, record.id))
        .returning();

      expect(updated.status).toBe("rejected");
      expect(updated.reviewNote).toBe("Short-staffed that week already.");
    });

    it("cancelling sets status to cancelled without touching reviewedByUserId", async () => {
      const [record] = await db
        .insert(schema.leaveRequests)
        .values({ restaurantId, userId, leaveType: "other", startDate: "2026-12-10", endDate: "2026-12-10" })
        .returning();

      const [updated] = await db
        .update(schema.leaveRequests)
        .set({ status: "cancelled" })
        .where(eq(schema.leaveRequests.id, record.id))
        .returning();

      expect(updated.status).toBe("cancelled");
      expect(updated.reviewedByUserId).toBeNull();
    });
  });

  describe("holidays duplicate guard + branch scoping", () => {
    it("isNull(branchId) correctly matches a restaurant-wide holiday (eq(col, null) would not)", async () => {
      await db.insert(schema.holidays).values({ restaurantId, branchId: null, date: "2026-10-20", name: "Dashain" });

      const [dup] = await db
        .select({ id: schema.holidays.id })
        .from(schema.holidays)
        .where(
          and(
            eq(schema.holidays.restaurantId, restaurantId),
            eq(schema.holidays.date, "2026-10-20"),
            isNull(schema.holidays.branchId),
          ),
        )
        .limit(1);
      expect(dup).toBeTruthy();
    });

    it("a branch-scoped holiday on the same date does NOT collide with the restaurant-wide one", async () => {
      const [record] = await db
        .insert(schema.holidays)
        .values({ restaurantId, branchId, date: "2026-10-20", name: "Branch renovation closure" })
        .returning();
      expect(record.branchId).toBe(branchId);

      const rowsForDate = await db
        .select()
        .from(schema.holidays)
        .where(and(eq(schema.holidays.restaurantId, restaurantId), eq(schema.holidays.date, "2026-10-20")));
      expect(rowsForDate.length).toBe(2); // the restaurant-wide one from the previous test + this branch-scoped one
    });

    it("deleting a holiday removes exactly that row", async () => {
      const [record] = await db
        .insert(schema.holidays)
        .values({ restaurantId, branchId: null, date: "2026-01-01", name: "New Year" })
        .returning();

      await db.delete(schema.holidays).where(eq(schema.holidays.id, record.id));

      const [gone] = await db.select().from(schema.holidays).where(eq(schema.holidays.id, record.id));
      expect(gone).toBeUndefined();
    });
  });
});
