/**
 * RC audit P1 fix (restaurant-facing audit log UI gap) — readable sentences
 * for audit event types whose metadata is structured enough to summarize,
 * rather than making a reader expand a raw JSON blob to understand what
 * happened. Impersonation events were the specifically called-out example
 * (an admin acting on a restaurant they don't have a real role at is
 * exactly the kind of entry a restaurant owner or a platform admin
 * reviewing the log most needs to understand at a glance), so those three
 * event types (start/exit/revoke) get a dedicated formatter; anything else
 * still falls back to the existing action-label + expandable-JSON
 * rendering, which is a perfectly fine default for the other 150+ action
 * strings this project records.
 *
 * Deliberately a plain, dependency-free module (no "server-only", no DB
 * import) — same rationale as order-status.ts: it needs to run in both the
 * tenant-side and platform-side audit log board client components, and
 * that also makes it trivially unit-testable without a database.
 */

export type AuditLogEntryForFormat = {
  action: string;
  metadata: Record<string, unknown> | null;
  /** The actor's display name — already resolved server-side (users.fullName), same field every AuditLogBoard already renders in its "Who" column. */
  userFullName?: string | null;
};

const IMPERSONATION_ACTIONS = new Set([
  "admin.impersonation_started",
  "admin.impersonation_ended",
  "admin.impersonation_revoked",
]);

/** "Read-only" is the safer-sounding default mode; only "write" needs calling out. */
function modeLabel(mode: unknown): string {
  return mode === "write" ? "read/write" : "read-only";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * "125000" -> "2 minutes 5 seconds". Rounds down to whole seconds first
 * (sub-second precision never matters for "how long was this admin acting
 * as this restaurant"), then keeps at most the two most significant units
 * so a multi-hour session doesn't read as "3 hours 14 minutes 7 seconds".
 * Never returns an empty string — a duration under a second still reads as
 * "less than a minute" rather than "0 minutes" or nothing at all, since
 * revoke can fire moments after start.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return "less than a minute";

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0 && parts.length < 2) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);

  return parts.length > 0 ? parts.join(" ") : "less than a minute";
}

/**
 * Formats the three impersonation event types into a plain sentence. Returns
 * null for anything else — including a genuinely unknown/malformed
 * impersonation entry (e.g. metadata missing entirely) — so callers can
 * fall back to the default action-label + JSON rendering rather than ever
 * showing a broken half-sentence.
 *
 * `restaurantLabel` lets a tenant-scoped board (every row already known to
 * be about "this restaurant") say exactly that instead of repeating the
 * restaurant's own name back to an owner already looking at their own
 * dashboard; the platform-wide board, which spans every tenant, omits it
 * so the sentence falls back to metadata's own targetRestaurantName.
 */
export function formatImpersonationEvent(
  entry: AuditLogEntryForFormat,
  opts: { restaurantLabel?: string } = {},
): string | null {
  if (!IMPERSONATION_ACTIONS.has(entry.action)) return null;

  const metadata = entry.metadata ?? {};
  const actor = entry.userFullName?.trim() || "An admin";
  const reason = asString(metadata.reason);
  const restaurant = opts.restaurantLabel ?? asString(metadata.targetRestaurantName) ?? "this restaurant";
  const reasonClause = reason ? ` (reason: "${reason}")` : "";

  switch (entry.action) {
    case "admin.impersonation_started": {
      const mode = modeLabel(metadata.mode);
      return `Platform admin ${actor} started a ${mode} impersonation session for ${restaurant}${reasonClause}.`;
    }
    case "admin.impersonation_ended": {
      const durationMs = asFiniteNumber(metadata.durationMs);
      const durationClause = durationMs !== null ? ` after ${formatDuration(durationMs)}` : "";
      return `Platform admin ${actor} exited impersonation of ${restaurant}${durationClause}${reasonClause}.`;
    }
    case "admin.impersonation_revoked": {
      const revokedAdminName = asString(metadata.revokedAdminName) ?? "another admin";
      const durationMs = asFiniteNumber(metadata.durationMs);
      const durationClause = durationMs !== null ? ` (active for ${formatDuration(durationMs)})` : "";
      return `Platform admin ${actor} revoked ${revokedAdminName}'s impersonation session of ${restaurant}${durationClause}${reasonClause}.`;
    }
    default:
      return null;
  }
}

/**
 * Dispatches to every readable-sentence formatter this module knows about.
 * Impersonation is the only structured formatter today; adding another
 * event type's formatter later just means adding another line here — the
 * AuditLogBoard call sites never need to change.
 */
export function formatAuditLogEntry(
  entry: AuditLogEntryForFormat,
  opts: { restaurantLabel?: string } = {},
): string | null {
  return formatImpersonationEvent(entry, opts);
}

/**
 * A short, generic annotation for context that applies to ANY action
 * (not just impersonation ones) when it happened under one of these two
 * modifiers — both currently only visible by expanding the raw metadata
 * JSON, even though "this refund was issued by an admin impersonating the
 * restaurant" or "...during a platform maintenance-mode outage" is exactly
 * the kind of thing an owner or a security reviewer scans the log for.
 * Returns null when neither modifier is set, so callers can skip rendering
 * anything extra.
 */
export function formatAuditLogModifiers(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const notes: string[] = [];
  if (metadata.isImpersonated === true) notes.push("via impersonation");
  if (metadata.duringMaintenanceMode === true) notes.push("during maintenance mode");
  return notes.length > 0 ? notes.join(", ") : null;
}
