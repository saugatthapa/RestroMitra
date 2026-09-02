/**
 * Phase 12 (Attendance overhaul, Track B) — integration test for
 * attendance-photos-db.ts: the consent ledger, the shared clock-in/out
 * photo resolution helper, and the retention purge job. Uses a real
 * Postgres connection (skipped without DATABASE_URL, same convention as
 * every other *-db.test.ts) AND a real in-process S3-compatible server
 * (test/s3rver-setup.ts — never skipped) together, since
 * resolveAttendancePhotoForClock and purgeExpiredAttendancePhotos both
 * genuinely span both backends.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { startTestObjectStorage } from "../../../test/s3rver-setup";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("attendance-photos-db (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let photosDb: typeof import("@/lib/attendance-photos-db");
  let storage: typeof import("@/lib/storage/object-storage-s3");
  let photoKey: typeof import("@/lib/storage/attendance-photo-key");
  let stopStorage: () => Promise<void>;

  let restaurantId: string;
  let userId: string;

  beforeAll(async () => {
    const started = await startTestObjectStorage();
    stopStorage = started.stop;

    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    photosDb = await import("@/lib/attendance-photos-db");
    storage = await import("@/lib/storage/object-storage-s3");
    photoKey = await import("@/lib/storage/attendance-photo-key");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Photo Staff", phone: `9758${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-photos-${suffix}`, name: "TEST Photos Restaurant", isActive: true })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;
  });

  afterAll(async () => {
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
    await db.delete(schema.attendancePhotoConsents).where(eq(schema.attendancePhotoConsents.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await stopStorage();
  });

  afterEach(async () => {
    await db
      .update(schema.restaurants)
      .set({ selfieClockInRequired: false, workplacePhotoRequired: false })
      .where(eq(schema.restaurants.id, restaurantId));
  });

  describe("consent ledger", () => {
    it("hasCurrentConsentForUser is false with no consent on file", async () => {
      expect(await photosDb.hasCurrentConsentForUser(userId, restaurantId)).toBe(false);
    });

    it("recordConsent then hasCurrentConsentForUser reflects it, and getLatestConsent returns the newest row", async () => {
      const first = await photosDb.recordConsent({ userId, restaurantId, ipAddress: "203.0.113.5" });
      expect(first.consentVersion).toBeTruthy();
      expect(await photosDb.hasCurrentConsentForUser(userId, restaurantId)).toBe(true);

      const latest = await photosDb.getLatestConsent(userId, restaurantId);
      expect(latest?.consentVersion).toBe(first.consentVersion);
    });

    it("recording consent again APPENDS a new row rather than updating the first — the ledger never shrinks", async () => {
      const before = await db
        .select()
        .from(schema.attendancePhotoConsents)
        .where(eq(schema.attendancePhotoConsents.userId, userId));
      const beforeCount = before.length;

      await photosDb.recordConsent({ userId, restaurantId, ipAddress: "203.0.113.9" });

      const after = await db
        .select()
        .from(schema.attendancePhotoConsents)
        .where(eq(schema.attendancePhotoConsents.userId, userId));
      expect(after.length).toBe(beforeCount + 1);
    });
  });

  describe("resolveAttendancePhotoForClock", () => {
    it("returns null when no key is sent and the restaurant doesn't require one — the plain no-photo clock-in/out stays fully supported", async () => {
      const result = await photosDb.resolveAttendancePhotoForClock({
        restaurantId,
        userId,
        kind: "clock_in",
        photoObjectKey: undefined,
      });
      expect(result).toBeNull();
    });

    it("throws when the restaurant requires a photo and none was sent", async () => {
      await db.update(schema.restaurants).set({ selfieClockInRequired: true }).where(eq(schema.restaurants.id, restaurantId));

      await expect(
        photosDb.resolveAttendancePhotoForClock({
          restaurantId,
          userId,
          kind: "clock_in",
          photoObjectKey: undefined,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws when the key doesn't belong to this restaurant/user/kind, even with valid consent", async () => {
      await photosDb.recordConsent({ userId, restaurantId, ipAddress: null });
      const wrongKind = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_out", // requesting clock_in below
        token: "mismatched-kind-token12",
      });

      await expect(
        photosDb.resolveAttendancePhotoForClock({
          restaurantId,
          userId,
          kind: "clock_in",
          photoObjectKey: wrongKind,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws when consent hasn't been recorded, even with a well-formed matching key", async () => {
      // A fresh user with no consent row at all.
      const suffix = Math.random().toString(36).slice(2, 8);
      const [unconsentedUser] = await db
        .insert(schema.users)
        .values({ fullName: "TEST Unconsented Staff", phone: `9759${suffix.slice(0, 6)}`, passwordHash: "x" })
        .returning({ id: schema.users.id });

      const key = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId: unconsentedUser.id,
        kind: "clock_in",
        token: "unconsented-token123",
      });

      await expect(
        photosDb.resolveAttendancePhotoForClock({
          restaurantId,
          userId: unconsentedUser.id,
          kind: "clock_in",
          photoObjectKey: key,
        }),
      ).rejects.toMatchObject({ status: 403 });

      await db.delete(schema.users).where(eq(schema.users.id, unconsentedUser.id));
    });

    it("throws when the key is well-formed and consented but was never actually uploaded", async () => {
      const key = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in",
        token: "never-uploaded-token1",
      });

      await expect(
        photosDb.resolveAttendancePhotoForClock({ restaurantId, userId, kind: "clock_in", photoObjectKey: key }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("returns the key when it's well-formed, consented, AND actually exists in storage — the full happy path", async () => {
      const key = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in",
        token: "real-upload-token123",
      });
      const { url } = await storage.createAttendancePhotoUploadUrl(key);
      const putRes = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: Buffer.from("real test selfie bytes"),
      });
      expect(putRes.ok).toBe(true);

      const result = await photosDb.resolveAttendancePhotoForClock({
        restaurantId,
        userId,
        kind: "clock_in",
        photoObjectKey: key,
      });
      expect(result).toBe(key);

      await storage.deleteAttendancePhoto(key);
    });
  });

  // P2 gap-audit fix — the separate, always-optional workplace/surroundings
  // photo. resolveAttendancePhotoForClock is the exact same shared function
  // exercised above for the selfie kinds, just called with a
  // "clock_in_workplace"/"clock_out_workplace" kind and gated by
  // workplacePhotoRequired instead of selfieClockInRequired — these mirror
  // the selfie describe block's coverage for that other branch.
  describe("resolveAttendancePhotoForClock — workplace photo", () => {
    it("returns null when no key is sent and workplacePhotoRequired is off, independent of selfieClockInRequired", async () => {
      const result = await photosDb.resolveAttendancePhotoForClock({
        restaurantId,
        userId,
        kind: "clock_in_workplace",
        photoObjectKey: undefined,
      });
      expect(result).toBeNull();
    });

    it("throws when workplacePhotoRequired is on and no key was sent, even though selfieClockInRequired is off", async () => {
      await db
        .update(schema.restaurants)
        .set({ workplacePhotoRequired: true })
        .where(eq(schema.restaurants.id, restaurantId));

      await expect(
        photosDb.resolveAttendancePhotoForClock({
          restaurantId,
          userId,
          kind: "clock_in_workplace",
          photoObjectKey: undefined,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("a selfie key is rejected for a workplace-photo request, even for the same restaurant/user/clock event", async () => {
      await photosDb.recordConsent({ userId, restaurantId, ipAddress: null });
      const selfieKey = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in",
        token: "selfie-not-workplace1",
      });

      await expect(
        photosDb.resolveAttendancePhotoForClock({
          restaurantId,
          userId,
          kind: "clock_in_workplace",
          photoObjectKey: selfieKey,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("returns the key when it's well-formed, consented, AND actually exists in storage — the workplace-photo happy path", async () => {
      await photosDb.recordConsent({ userId, restaurantId, ipAddress: null });
      const key = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in_workplace",
        token: "real-workplace-token1",
      });
      const { url } = await storage.createAttendancePhotoUploadUrl(key);
      const putRes = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: Buffer.from("real test workplace bytes"),
      });
      expect(putRes.ok).toBe(true);

      const result = await photosDb.resolveAttendancePhotoForClock({
        restaurantId,
        userId,
        kind: "clock_in_workplace",
        photoObjectKey: key,
      });
      expect(result).toBe(key);

      await storage.deleteAttendancePhoto(key);
    });
  });

  // P2 gap-audit fix — the actual attendance_records row: proves a
  // clock-in can carry BOTH photos at once, and that omitting the
  // workplace photo (the pre-existing, selfie-only shape) still persists
  // exactly as it did before this column existed.
  describe("attendance_records: selfie + workplace photo columns", () => {
    it("a clock-in with BOTH a selfie and a workplace photo key persists both, independently", async () => {
      const selfieKey = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in",
        token: "both-photos-selfie1234",
      });
      const workplaceKey = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in_workplace",
        token: "both-photos-workplace1",
      });

      const [record] = await db
        .insert(schema.attendanceRecords)
        .values({
          restaurantId,
          userId,
          clockInPhotoObjectKey: selfieKey,
          clockInWorkplacePhotoObjectKey: workplaceKey,
          clockOutAt: new Date(), // closed shift — keeps this test independent of the one-open-shift-per-user constraint
        })
        .returning();

      expect(record.clockInPhotoObjectKey).toBe(selfieKey);
      expect(record.clockInWorkplacePhotoObjectKey).toBe(workplaceKey);

      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.id, record.id));
    });

    it("a clock-in with ONLY a selfie (workplace photo omitted) still works exactly as before — the column is null, nothing else breaks", async () => {
      const selfieKey = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in",
        token: "selfie-only-legacy1234",
      });

      const [record] = await db
        .insert(schema.attendanceRecords)
        .values({
          restaurantId,
          userId,
          clockInPhotoObjectKey: selfieKey,
          clockOutAt: new Date(),
        })
        .returning();

      expect(record.clockInPhotoObjectKey).toBe(selfieKey);
      expect(record.clockInWorkplacePhotoObjectKey).toBeNull();
      expect(record.clockOutWorkplacePhotoObjectKey).toBeNull();

      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.id, record.id));
    });

    it("a clock-in with NEITHER photo (the original, pre-Phase-12 shape) still works — both selfie and workplace columns are null", async () => {
      const [record] = await db
        .insert(schema.attendanceRecords)
        .values({
          restaurantId,
          userId,
          clockOutAt: new Date(),
        })
        .returning();

      expect(record.clockInPhotoObjectKey).toBeNull();
      expect(record.clockInWorkplacePhotoObjectKey).toBeNull();

      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.id, record.id));
    });
  });

  describe("purgeExpiredAttendancePhotos", () => {
    // purgeExpiredAttendancePhotos deliberately queries attendance_records
    // across ALL restaurants (it's a platform-wide retention job, not
    // tenant-scoped) — which would ordinarily raise the same
    // cross-test-file-parallelism concern documented in system-db.test.ts
    // for the Phase 10 maintenance-mode singleton. It's safe here for a
    // simpler reason than that file's: clockInPhotoObjectKey/
    // clockOutPhotoObjectKey are BRAND NEW columns this same phase adds
    // (confirmed via grep — no other test file or seed script sets them),
    // so no other test file's fixtures can ever match this query's
    // isNotNull(...) filter and get swept up by a concurrent run.
    it("deletes photos past retention, clears the DB columns, and leaves recent records untouched", async () => {
      const oldKey = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in",
        token: "old-record-token12345",
      });
      const { url: oldUploadUrl } = await storage.createAttendancePhotoUploadUrl(oldKey);
      await fetch(oldUploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: Buffer.from("old selfie"),
      });

      const veryOld = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
      const [oldRecord] = await db
        .insert(schema.attendanceRecords)
        .values({
          restaurantId,
          userId,
          clockInAt: veryOld,
          clockOutAt: new Date(veryOld.getTime() + 3600_000),
          clockInPhotoObjectKey: oldKey,
        })
        .returning();

      const recentKey = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in",
        token: "recent-record-token1",
      });
      const [recentRecord] = await db
        .insert(schema.attendanceRecords)
        .values({
          restaurantId,
          userId,
          clockOutAt: new Date(),
          clockInPhotoObjectKey: recentKey, // never actually uploaded — irrelevant, purge doesn't verify existence, only age
        })
        .returning();

      const result = await photosDb.purgeExpiredAttendancePhotos(90);
      expect(result.recordsPurged).toBeGreaterThanOrEqual(1);

      const [oldAfter] = await db
        .select()
        .from(schema.attendanceRecords)
        .where(eq(schema.attendanceRecords.id, oldRecord.id));
      expect(oldAfter.clockInPhotoObjectKey).toBeNull();

      const [recentAfter] = await db
        .select()
        .from(schema.attendanceRecords)
        .where(eq(schema.attendanceRecords.id, recentRecord.id));
      expect(recentAfter.clockInPhotoObjectKey).toBe(recentKey); // untouched — not old enough
    });

    // P2 gap-audit fix — the workplace photo columns must be swept by the
    // same retention job as the selfie columns, on their own (a record
    // with ONLY a workplace photo and no selfie at all — e.g. a
    // restaurant with workplacePhotoRequired on but selfieClockInRequired
    // off) rather than only when riding along with a selfie.
    it("also purges a record whose ONLY photo is the workplace one, with no selfie at all", async () => {
      const oldWorkplaceKey = photoKey.buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in_workplace",
        token: "old-workplace-token12",
      });
      const { url } = await storage.createAttendancePhotoUploadUrl(oldWorkplaceKey);
      await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: Buffer.from("old workplace photo"),
      });

      const veryOld = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
      const [oldRecord] = await db
        .insert(schema.attendanceRecords)
        .values({
          restaurantId,
          userId,
          clockInAt: veryOld,
          clockOutAt: new Date(veryOld.getTime() + 3600_000),
          clockInWorkplacePhotoObjectKey: oldWorkplaceKey,
        })
        .returning();

      await photosDb.purgeExpiredAttendancePhotos(90);

      const [after] = await db
        .select()
        .from(schema.attendanceRecords)
        .where(eq(schema.attendanceRecords.id, oldRecord.id));
      expect(after.clockInWorkplacePhotoObjectKey).toBeNull();
    });
  });
});
