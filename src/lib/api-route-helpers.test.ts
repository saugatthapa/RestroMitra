/**
 * RC audit P1 regression test: proves toErrorResponse() (the shared error
 * handler ~76 API routes funnel through) actually reports an unrecognized,
 * unhandled error to Sentry — previously it only ever `console.error`d and
 * returned an opaque 500, which is exactly why the dominant class of "API
 * failure" never reached Sentry even with a DSN configured (this
 * catch-everything pattern means the error never escapes uncaught, so
 * instrumentation.ts's own onRequestError hook never fires for it either).
 *
 * Also proves the inverse: a recognized HttpError (a 404/400/403 — an
 * expected, not-a-bug failure) must NOT be reported, so Sentry isn't
 * flooded with routine, already-handled rejections.
 *
 * @sentry/nextjs is mocked (vi.mock) rather than exercised for real —
 * this project has no SENTRY_DSN set in the test environment, and the SDK
 * is designed to no-op silently until Sentry.init() has actually run
 * (see sentry.server.config.ts's own comment), which would make a
 * call-was-made assertion impossible to observe without mocking.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const captureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

describe("toErrorResponse", () => {
  beforeEach(() => {
    captureException.mockClear();
  });

  it("reports an unrecognized, unhandled error to Sentry and returns an opaque 500", async () => {
    const { toErrorResponse } = await import("./api-route-helpers");
    const err = new Error("something exploded deep in a query");
    const res = toErrorResponse(err);

    expect(res.status).toBe(500);
    const body = await res.json();
    // Never leak internal error details to the client.
    expect(body.error).toBe("Something went wrong. Please try again.");
    expect(body.error).not.toContain("exploded");

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(err);
  });

  it("does NOT report a recognized HttpError to Sentry", async () => {
    const { toErrorResponse } = await import("./api-route-helpers");
    const { HttpError } = await import("./http-error");
    const err = new HttpError("Order not found.", 404);
    const res = toErrorResponse(err);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found.");

    expect(captureException).not.toHaveBeenCalled();
  });
});
