/**
 * Shared base for "throw and let the route handler convert it to a JSON
 * response" errors. AuthError (rbac/guard.ts) and OrderValidationError
 * (orders.ts) both extend this so a single toErrorResponse() in
 * api-route-helpers.ts can handle either without route handlers needing to
 * know which one they might catch.
 */
export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
