/**
 * RC audit P1 fix (restaurant-facing audit log UI gap) — builds the
 * `?...` query string both AuditLogBoard components (tenant-side and
 * platform-side) send to their respective GET /audit-log routes. Pulled
 * out of the client component into a plain, dependency-free function so
 * the "which filters actually make it onto the request" logic is
 * unit-testable without mounting a component or mocking fetch.
 *
 * Every filter is optional and blank/whitespace-only values are dropped
 * rather than sent as empty params — matches the "" == "no filter" the
 * <select>/<input> controls already use for their unset state, and keeps
 * the request URL identical to the pre-filter-bar happy path when nothing
 * is set.
 */

export type AuditLogFilters = {
  /** Free-text action prefix, e.g. "payment" — trimmed before use, same as the pre-existing filter box. */
  action?: string;
  resourceType?: string;
  userId?: string;
  branchId?: string;
  /** YYYY-MM-DD, inclusive on both ends — see the API route's own doc comment. */
  from?: string;
  to?: string;
};

export type AuditLogPaging = {
  limit: number;
  offset: number;
};

export function buildAuditLogParams(filters: AuditLogFilters, paging: AuditLogPaging): URLSearchParams {
  const params = new URLSearchParams({
    limit: String(paging.limit),
    offset: String(paging.offset),
  });

  const action = filters.action?.trim();
  if (action) params.set("action", action);
  if (filters.resourceType) params.set("resourceType", filters.resourceType);
  if (filters.userId) params.set("userId", filters.userId);
  if (filters.branchId) params.set("branchId", filters.branchId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);

  return params;
}
