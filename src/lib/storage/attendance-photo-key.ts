/**
 * Phase 12 (Attendance overhaul, Track B) — object-storage key naming for
 * attendance selfies. Deliberately a plain, dependency-free module (no
 * "server-only", no AWS SDK import) so both the presigned-upload-URL route
 * (which mints a key) and the clock-in/out routes (which must verify a
 * client-supplied key actually belongs to THIS restaurant+user+kind before
 * trusting it) share the exact same key shape and parser, rather than two
 * routes independently reimplementing a regex that could drift apart.
 *
 * Shape: attendance-photos/{restaurantId}/{userId}/{kind}/{isoDate}-{token}.jpg
 * - restaurantId/userId are embedded (not just implied by an authenticated
 *   session) so a key can be validated as belonging to the right tenant
 *   and person purely by string inspection, before ever calling out to
 *   storage — the same "resolve, don't trust" pattern this codebase uses
 *   for client-supplied ids everywhere else (see e.g. staff/route.ts's
 *   branchId handling).
 * - kind is "clock_in" | "clock_out" | "clock_in_workplace" |
 *   "clock_out_workplace", matching the FOUR DB columns it can end up
 *   written into (P2 gap-audit fix added the two "_workplace" kinds,
 *   alongside the original selfie-only pair, for the separate
 *   workplace/surroundings photo — same key shape, just one more segment
 *   value, so the upload-URL route, the clock-in/out routes, and this
 *   parser all keep working unmodified for both photo types).
 * - token is a random opaque id (minted by the upload-URL route, never
 *   client-chosen) so a key can't be guessed or enumerated even by someone
 *   who knows a restaurantId/userId pair.
 */

export type AttendancePhotoKind = "clock_in" | "clock_out" | "clock_in_workplace" | "clock_out_workplace";

const KEY_PATTERN =
  /^attendance-photos\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/(clock_in_workplace|clock_out_workplace|clock_in|clock_out)\/[0-9T:.Z-]+-([A-Za-z0-9_-]{16,64})\.jpg$/;

export function buildAttendancePhotoKey(params: {
  restaurantId: string;
  userId: string;
  kind: AttendancePhotoKind;
  token: string;
  now?: Date;
}): string {
  const isoDate = (params.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  return `attendance-photos/${params.restaurantId}/${params.userId}/${params.kind}/${isoDate}-${params.token}.jpg`;
}

/**
 * Parses a key and confirms it belongs to the given restaurant+user+kind.
 * Returns false for a malformed key OR one whose embedded ids/kind don't
 * match — the caller never needs to separately re-check the parsed parts.
 */
export function isAttendancePhotoKeyFor(
  key: string,
  params: { restaurantId: string; userId: string; kind: AttendancePhotoKind },
): boolean {
  const match = KEY_PATTERN.exec(key);
  if (!match) return false;
  const [, restaurantId, userId, kind] = match;
  return restaurantId === params.restaurantId && userId === params.userId && kind === params.kind;
}
