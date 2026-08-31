/**
 * Phase 15 (Attendance overhaul, Track B — Scheduling) — integration test
 * for the schedule routes' underlying DB shapes: the POST route's
 * active-staff-membership check, the GET route's shift+attendance query
 * shapes feeding matchScheduleWithAttendance, and the update/delete paths.
 * Same limitation as attendance-corrections-db.test.ts and leave-db.test.ts
 * — these routes depend on resolveRestaurantContext()/cookies(), so they
 * can't be exercised end-to-end here (no session-mocking harness).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { restaurantStartOfDay, restaurantEndOfDay, restaurantWallClockToUtc } from "@/lib/restaurant-date";
import { weekRangeContaining } from "@/lib/scheduling";
import { matchScheduleWithAttendance } from "@/lib/scheduling-db";

const hasDb = Boolean(process.env.DATABASE_URL);
const TZ = "Asia/Kathmandu";

describe.skipIf(!hasDb)("scheduling (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let userId: string;
  let inactiveUserId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [staff] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Schedule Staff", phone: `9753${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = staff.id;

    const [formerStaff] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Former Staff", phone: `9752${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    inactiveUserId = formerStaff.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-schedule-${suffix}`, name: "TEST Schedule Restaurant", isActive: true, timezone: TZ })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    await db.insert(schema.userRoles).values([
      { userId, restaurantId, role: "waiter", isActive: true },
      { userId: inactiveUserId, restaurantId, role: "waiter", isActive: false },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.scheduledShifts).where(eq(schema.scheduledShifts.restaurantId, restaurantId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, inactiveUserId));
  });

  describe("POST route's active-staff-membership check", () => {
    it("finds an active staff member's user_roles row", async () => {
      const [row] = await db
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.userId, userId),
            eq(schema.userRoles.restaurantId, restaurantId),
            eq(schema.userRoles.isActive, true),
          ),
        )
        .limit(1);
      expect(row).toBeTruthy();
    });

    it("does NOT find a deactivated staff member — the route must 404 rather than schedule them", async () => {
      const [row] = await db
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.userId, inactiveUserId),
            eq(schema.userRoles.restaurantId, restaurantId),
            eq(schema.userRoles.isActive, true),
          ),
        )
        .limit(1);
      expect(row).toBeUndefined();
    });
  });

  describe("creating a shift via restaurantWallClockToUtc + real insert", () => {
    it("stores plannedStartAt/plannedEndAt as the correct UTC instants for a Nepal-timezone restaurant", async () => {
      const plannedStartAt = restaurantWallClockToUtc(TZ, "2026-09-01", "09:00");
      const plannedEndAt = restaurantWallClockToUtc(TZ, "2026-09-01", "17:00");

      const [record] = await db
        .insert(schema.scheduledShifts)
        .values({ restaurantId, userId, shiftDate: "2026-09-01", plannedStartAt, plannedEndAt })
        .returning();

      expect(record.plannedStartAt.toISOString()).toBe("2026-09-01T03:15:00.000Z");
      expect(record.plannedEndAt.toISOString()).toBe("2026-09-01T11:15:00.000Z");
    });
  });

  describe("GET route's query shapes feeding matchScheduleWithAttendance", () => {
    it("end to end: a real shift + a real attendance record in the DB match up with the correct variance", async () => {
      const [from, to] = weekRangeContaining("2026-09-02"); // a Wednesday
      const plannedStartAt = restaurantWallClockToUtc(TZ, "2026-09-02", "09:00");
      const plannedEndAt = restaurantWallClockToUtc(TZ, "2026-09-02", "17:00");
      await db
        .insert(schema.scheduledShifts)
        .values({ restaurantId, userId, shiftDate: "2026-09-02", plannedStartAt, plannedEndAt });

      // Clocked in 20 minutes late (in Nepal wall-clock terms).
      const clockInAt = restaurantWallClockToUtc(TZ, "2026-09-02", "09:20");
      const clockOutAt = restaurantWallClockToUtc(TZ, "2026-09-02", "17:00");
      await db.insert(schema.attendanceRecords).values({ restaurantId, userId, clockInAt, clockOutAt });

      const shiftRows = await db
        .select({
          id: schema.scheduledShifts.id,
          userId: schema.scheduledShifts.userId,
          shiftDate: schema.scheduledShifts.shiftDate,
          plannedStartAt: schema.scheduledShifts.plannedStartAt,
          plannedEndAt: schema.scheduledShifts.plannedEndAt,
        })
        .from(schema.scheduledShifts)
        .where(
          and(
            eq(schema.scheduledShifts.restaurantId, restaurantId),
            gte(schema.scheduledShifts.shiftDate, from),
            lte(schema.scheduledShifts.shiftDate, to),
          ),
        );

      const windowStart = restaurantStartOfDay(TZ, from);
      const windowEnd = restaurantEndOfDay(TZ, to);
      const attendanceRows = await db
        .select({
          userId: schema.attendanceRecords.userId,
          clockInAt: schema.attendanceRecords.clockInAt,
          clockOutAt: schema.attendanceRecords.clockOutAt,
        })
        .from(schema.attendanceRecords)
        .where(
          and(
            eq(schema.attendanceRecords.restaurantId, restaurantId),
            gte(schema.attendanceRecords.clockInAt, windowStart),
            lte(schema.attendanceRecords.clockInAt, windowEnd),
            inArray(schema.attendanceRecords.userId, [userId]),
          ),
        );

      const matched = matchScheduleWithAttendance(shiftRows, attendanceRows, TZ, new Date("2026-09-02T20:00:00Z"));
      const thisShift = matched.find((m) => m.shift.shiftDate === "2026-09-02");
      expect(thisShift?.attendance).not.toBeNull();
      expect(thisShift?.variance.status).toBe("completed");
      expect(thisShift?.variance.lateMinutes).toBe(15); // 20 min late - 5 min grace
      expect(thisShift?.variance.earlyDepartureMinutes).toBe(0);
    });
  });

  describe("update + delete", () => {
    it("rescheduling to a new date/time via restaurantTimeOfDay + restaurantWallClockToUtc round-trips correctly", async () => {
      const originalStart = restaurantWallClockToUtc(TZ, "2026-09-03", "10:00");
      const originalEnd = restaurantWallClockToUtc(TZ, "2026-09-03", "18:00");
      const [record] = await db
        .insert(schema.scheduledShifts)
        .values({ restaurantId, userId, shiftDate: "2026-09-03", plannedStartAt: originalStart, plannedEndAt: originalEnd })
        .returning();

      // Move the shift to a new date, keeping the same times (this exercises
      // the PATCH route's "only shiftDate changed" fallback path — see
      // restaurantTimeOfDay's own comment on why it can't just reuse the
      // raw UTC hour/minute here).
      const { restaurantTimeOfDay } = await import("@/lib/restaurant-date");
      const startTime = restaurantTimeOfDay(TZ, record.plannedStartAt);
      const endTime = restaurantTimeOfDay(TZ, record.plannedEndAt);
      expect(startTime).toBe("10:00");
      expect(endTime).toBe("18:00");

      const nextShiftDate = "2026-09-04";
      const nextStart = restaurantWallClockToUtc(TZ, nextShiftDate, startTime);
      const nextEnd = restaurantWallClockToUtc(TZ, nextShiftDate, endTime);

      const [updated] = await db
        .update(schema.scheduledShifts)
        .set({ shiftDate: nextShiftDate, plannedStartAt: nextStart, plannedEndAt: nextEnd })
        .where(eq(schema.scheduledShifts.id, record.id))
        .returning();

      expect(updated.shiftDate).toBe(nextShiftDate);
      expect(restaurantTimeOfDay(TZ, updated.plannedStartAt)).toBe("10:00");
      expect(restaurantTimeOfDay(TZ, updated.plannedEndAt)).toBe("18:00");
    });

    it("deleting a shift removes exactly that row", async () => {
      const [record] = await db
        .insert(schema.scheduledShifts)
        .values({
          restaurantId,
          userId,
          shiftDate: "2026-09-05",
          plannedStartAt: restaurantWallClockToUtc(TZ, "2026-09-05", "09:00"),
          plannedEndAt: restaurantWallClockToUtc(TZ, "2026-09-05", "17:00"),
        })
        .returning();

      await db.delete(schema.scheduledShifts).where(eq(schema.scheduledShifts.id, record.id));

      const [gone] = await db.select().from(schema.scheduledShifts).where(eq(schema.scheduledShifts.id, record.id));
      expect(gone).toBeUndefined();
    });
  });
});
