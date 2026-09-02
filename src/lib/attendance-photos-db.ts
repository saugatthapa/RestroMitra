import "server-only";
import { and, desc, eq, isNotNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { attendancePhotoConsents, attendanceRecords, restaurants } from "@/db/schema";
import { CURRENT_CONSENT_VERSION, hasCurrentConsent } from "@/lib/attendance-consent";
import { deleteAttendancePhoto, headAttendancePhoto } from "@/lib/storage/object-storage-s3";
import { isAttendancePhotoKeyFor, type AttendancePhotoKind } from "@/lib/storage/attendance-photo-key";
import { recordAuditLog } from "@/lib/audit";
import { HttpError } from "@/lib/http-error";

/**
 * Phase 12 (Attendance overhaul, Track B) — DB-backed half of consent
 * tracking and photo retention. Deliberately separate from the pure
 * attendance-consent.ts (notice text + hasCurrentConsent's pure
 * version-compare) — same "*-db.ts wraps the DB, the plain module carries
 * the shareable logic" split as attendance.ts/attendance-photos-db.ts,
 * entitlements.ts/entitlements-db.ts, etc.
 */

export async function getLatestConsent(userId: string, restaurantId: string) {
  const [row] = await db
    .select({ consentVersion: attendancePhotoConsents.consentVersion, consentedAt: attendancePhotoConsents.consentedAt })
    .from(attendancePhotoConsents)
    .where(and(eq(attendancePhotoConsents.userId, userId), eq(attendancePhotoConsents.restaurantId, restaurantId)))
    .orderBy(desc(attendancePhotoConsents.consentedAt))
    .limit(1);
  return row ?? null;
}

export async function hasCurrentConsentForUser(userId: string, restaurantId: string): Promise<boolean> {
  const latest = await getLatestConsent(userId, restaurantId);
  return hasCurrentConsent(latest);
}

/** Appends a new consent row for CURRENT_CONSENT_VERSION — never updates a prior row (see schema.ts's own comment on why this is a ledger). */
export async function recordConsent(params: {
  userId: string;
  restaurantId: string;
  ipAddress: string | null;
}) {
  const [row] = await db
    .insert(attendancePhotoConsents)
    .values({
      userId: params.userId,
      restaurantId: params.restaurantId,
      consentVersion: CURRENT_CONSENT_VERSION,
      ipAddress: params.ipAddress,
    })
    .returning();
  return row;
}

const DEFAULT_RETENTION_DAYS = 90;

/**
 * How long an attendance photo is kept before the retention purge deletes
 * it — ATTENDANCE_PHOTO_RETENTION_DAYS if set (and a positive integer),
 * otherwise a 90-day default. Not a legally mandated number (see
 * attendance-consent.ts's own comment on Nepal's Individual Privacy Act
 * not prescribing one) — an operational default an operator can override
 * per deployment.
 */
export function getAttendancePhotoRetentionDays(): number {
  const raw = process.env.ATTENDANCE_PHOTO_RETENTION_DAYS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

/**
 * Deletes stored photos (and clears the DB columns pointing to them) for
 * every attendance record whose clock-in happened more than
 * `retentionDays` ago and still has a photo key on file. Idempotent and
 * safe to re-run: a record with both keys already null is simply not
 * matched. Storage-delete failures for one record don't abort the whole
 * pass — each record is handled independently so one bad key can't block
 * the rest of the purge; failures are collected and returned rather than
 * thrown, since this is meant to be run unattended (see the platform
 * admin route that calls this).
 *
 * Not wired to any in-app scheduler — this codebase has no background job
 * runner (see rate-limit.ts's own note on single-process limitations for
 * the same "no shared infra beyond Postgres" reality). Intended to be
 * invoked periodically by an operator via the platform-admin route this
 * backs, e.g. from an external cron hitting that endpoint.
 */
export async function purgeExpiredAttendancePhotos(
  retentionDays: number,
): Promise<{ recordsPurged: number; photosDeleted: number; failures: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: attendanceRecords.id,
      restaurantId: attendanceRecords.restaurantId,
      clockInPhotoObjectKey: attendanceRecords.clockInPhotoObjectKey,
      clockOutPhotoObjectKey: attendanceRecords.clockOutPhotoObjectKey,
      // P2 gap-audit fix — the workplace photo columns sweep through the
      // same retention job as the selfie columns; a workplace photo is
      // just as much "a photo of where someone was" as a selfie is, so it
      // gets the same expiry, not an indefinite retention by omission.
      clockInWorkplacePhotoObjectKey: attendanceRecords.clockInWorkplacePhotoObjectKey,
      clockOutWorkplacePhotoObjectKey: attendanceRecords.clockOutWorkplacePhotoObjectKey,
    })
    .from(attendanceRecords)
    .where(
      and(
        lt(attendanceRecords.clockInAt, cutoff),
        or(
          isNotNull(attendanceRecords.clockInPhotoObjectKey),
          isNotNull(attendanceRecords.clockOutPhotoObjectKey),
          isNotNull(attendanceRecords.clockInWorkplacePhotoObjectKey),
          isNotNull(attendanceRecords.clockOutWorkplacePhotoObjectKey),
        ),
      ),
    );

  let photosDeleted = 0;
  let failures = 0;

  for (const row of rows) {
    const keys = [
      row.clockInPhotoObjectKey,
      row.clockOutPhotoObjectKey,
      row.clockInWorkplacePhotoObjectKey,
      row.clockOutWorkplacePhotoObjectKey,
    ].filter((k): k is string => k !== null);
    let allOk = true;
    for (const key of keys) {
      try {
        await deleteAttendancePhoto(key);
        photosDeleted += 1;
      } catch (err) {
        allOk = false;
        failures += 1;
        console.error(`Failed to delete attendance photo ${key} for record ${row.id}:`, err);
      }
    }
    if (!allOk) continue; // leave the DB columns as-is so a re-run retries the still-undeleted key(s)

    await db
      .update(attendanceRecords)
      .set({
        clockInPhotoObjectKey: null,
        clockOutPhotoObjectKey: null,
        clockInWorkplacePhotoObjectKey: null,
        clockOutWorkplacePhotoObjectKey: null,
      })
      .where(eq(attendanceRecords.id, row.id));

    await recordAuditLog({
      restaurantId: row.restaurantId,
      userId: null,
      action: "attendance.photos_purged",
      resourceType: "attendance_record",
      resourceId: row.id,
      metadata: { retentionDays, reason: "retention_expired" },
    });
  }

  return { recordsPurged: rows.length, photosDeleted, failures };
}

// P2 gap-audit fix — true for the two "_workplace" kinds, false for the
// original selfie pair. Used below to pick which restaurant-level
// required-toggle and which user-facing copy applies, without the two
// photo types needing two near-duplicate resolver functions.
function isWorkplacePhotoKind(kind: AttendancePhotoKind): boolean {
  return kind === "clock_in_workplace" || kind === "clock_out_workplace";
}

/**
 * Shared by both clock-in and clock-out routes: resolves whatever
 * photoObjectKey the client sent into either a verified key to persist or
 * an HttpError to surface, factoring out logic that would otherwise be
 * duplicated between the two routes. Throws (never returns a "soft"
 * failure) since every case here — a required photo missing, a key that
 * doesn't belong to this user/restaurant/kind, an unconsented user, a key
 * that doesn't actually exist in the bucket — is one the route should stop
 * and reject on, not silently work around.
 *
 * Returns null (not an error) when no photo applies: the relevant
 * required-toggle is off AND the client sent no key — the ordinary, still
 * fully-supported no-photo clock-in/out.
 *
 * P2 gap-audit fix — this same function now also resolves the separate
 * workplace/surroundings photo (kind "clock_in_workplace" /
 * "clock_out_workplace"), gated by restaurants.workplacePhotoRequired
 * instead of selfieClockInRequired; every other check (key-shape/tenant
 * match, consent, bucket existence) is identical for both photo types, so
 * one shared resolver — not a parallel copy — handles both, called twice
 * (once per photo) from each clock-in/out route.
 */
export async function resolveAttendancePhotoForClock(params: {
  restaurantId: string;
  userId: string;
  kind: AttendancePhotoKind;
  photoObjectKey: string | undefined;
}): Promise<string | null> {
  const [restaurantRow] = await db
    .select({
      selfieClockInRequired: restaurants.selfieClockInRequired,
      workplacePhotoRequired: restaurants.workplacePhotoRequired,
    })
    .from(restaurants)
    .where(eq(restaurants.id, params.restaurantId))
    .limit(1);
  const workplace = isWorkplacePhotoKind(params.kind);
  const required = workplace
    ? (restaurantRow?.workplacePhotoRequired ?? false)
    : (restaurantRow?.selfieClockInRequired ?? false);

  if (!params.photoObjectKey) {
    if (required) {
      throw new HttpError(
        workplace
          ? "This restaurant requires a workplace photo to clock in/out. Please take a photo first."
          : "This restaurant requires a selfie to clock in/out. Please take a photo first.",
        400,
      );
    }
    return null;
  }

  if (!isAttendancePhotoKeyFor(params.photoObjectKey, params)) {
    throw new HttpError("That photo doesn't match this request — please retake it.", 400);
  }

  // Both photo types share the one consent notice recorded at
  // photo-consent — the notice covers "attendance photos" generally, not
  // only the selfie, so a workplace-only capture still requires it before
  // this server will mint an upload URL or accept a key.
  const consented = await hasCurrentConsentForUser(params.userId, params.restaurantId);
  if (!consented) {
    throw new HttpError("You need to accept the selfie-capture consent notice first.", 403);
  }

  const { exists } = await headAttendancePhoto(params.photoObjectKey);
  if (!exists) {
    throw new HttpError("We couldn't verify your photo upload — please retake it and try again.", 400);
  }

  return params.photoObjectKey;
}
