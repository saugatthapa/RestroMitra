import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEventStream } from "./realtime";

/**
 * QA hardening (P2 backlog): regression test for the `cancel()` no-op fix.
 * `createEventStream`'s `fetchEvents`/`wakeKey` are both injected, so this
 * is fully testable without a database or a session — no route handler
 * involved, matching this codebase's convention that only DB/session-
 * dependent logic needs the heavier `src/db/__tests__` integration harness.
 *
 * Uses fake timers because the poll loop's only real-world wait is a
 * `setTimeout` inside `waitForWake` (1s per iteration, from
 * DEFAULT_POLL_INTERVAL_MS) — without faking it, proving "no further polls
 * happen after cancel" would mean actually waiting out multiple real
 * seconds per assertion.
 */
describe("createEventStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops polling as soon as the stream is cancelled, instead of riding out the max-duration cap", async () => {
    const fetchEvents = vi.fn(async () => []);

    const stream = createEventStream({
      fetchEvents,
      initialCursor: 0,
      wakeKey: "test-restaurant-cancel",
    });
    const reader = stream.getReader();

    // Drain the initial `retry: 2000` comment the stream always sends first.
    await reader.read();

    // Let a few poll cycles actually happen (each iteration awaits a 1s
    // setTimeout via waitForWake — advance past several of them).
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const callsBeforeCancel = fetchEvents.mock.calls.length;
    expect(callsBeforeCancel).toBeGreaterThan(0);

    await reader.cancel();

    // Advance well past what would have been many more 1s poll cycles, and
    // past the full 20s DEFAULT_MAX_DURATION_MS cap the old code would have
    // ridden out before the fix.
    await vi.advanceTimersByTimeAsync(25_000);

    expect(fetchEvents.mock.calls.length).toBe(callsBeforeCancel);
  });

  it("keeps polling normally (not cancelled) up to the max-duration cap when nothing cancels it", async () => {
    const fetchEvents = vi.fn(async () => []);

    const stream = createEventStream({
      fetchEvents,
      initialCursor: 0,
      wakeKey: "test-restaurant-normal",
    });
    const reader = stream.getReader();

    await reader.read();

    await vi.advanceTimersByTimeAsync(1000);
    const callsAfterOneTick = fetchEvents.mock.calls.length;
    expect(callsAfterOneTick).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(1000);
    // Still polling — proves the earlier test's zero-growth result really
    // does come from cancellation, not from the loop having already ended
    // for some unrelated reason.
    expect(fetchEvents.mock.calls.length).toBeGreaterThan(callsAfterOneTick);
  });
});
