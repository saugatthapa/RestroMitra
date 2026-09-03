/**
 * Gap-audit P1 fix (Finding 3) — unit test for the in-memory recent-errors
 * ring buffer that feeds the platform admin console's "recent alerts"
 * list. Pure, no DB — see error-log.ts's own doc comment for why this is
 * in-process rather than DB-backed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordSystemError,
  listRecentSystemErrors,
  clearSystemErrors,
  _resetSystemErrorLogForTests,
} from "./error-log";

describe("error-log", () => {
  beforeEach(() => {
    _resetSystemErrorLogForTests();
  });

  it("records an Error's message and returns it newest-first", () => {
    recordSystemError(new Error("first"));
    recordSystemError(new Error("second"));
    const recent = listRecentSystemErrors();
    expect(recent.map((e) => e.message)).toEqual(["second", "first"]);
    expect(recent[0].createdAt).toBeInstanceOf(Date);
  });

  it("handles a non-Error thrown value without throwing", () => {
    expect(() => recordSystemError("a plain string error")).not.toThrow();
    expect(() => recordSystemError({ some: "object" })).not.toThrow();
    expect(() => recordSystemError(undefined)).not.toThrow();
    const recent = listRecentSystemErrors();
    expect(recent).toHaveLength(3);
  });

  it("truncates a very long message", () => {
    recordSystemError(new Error("x".repeat(1000)));
    expect(listRecentSystemErrors()[0].message.length).toBe(500);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) recordSystemError(new Error(`err-${i}`));
    expect(listRecentSystemErrors(3)).toHaveLength(3);
    expect(listRecentSystemErrors(3).map((e) => e.message)).toEqual(["err-9", "err-8", "err-7"]);
  });

  it("caps total retained entries so this never grows unbounded", () => {
    for (let i = 0; i < 250; i++) recordSystemError(new Error(`err-${i}`));
    const all = listRecentSystemErrors(1000);
    expect(all.length).toBeLessThanOrEqual(200);
    // The newest entry is still there; the oldest ones were evicted.
    expect(all[0].message).toBe("err-249");
  });

  it("clearSystemErrors empties the list", () => {
    recordSystemError(new Error("one"));
    recordSystemError(new Error("two"));
    expect(listRecentSystemErrors()).toHaveLength(2);
    clearSystemErrors();
    expect(listRecentSystemErrors()).toHaveLength(0);
  });
});
