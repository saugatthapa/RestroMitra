import { describe, it, expect } from "vitest";
import { canTransition, nextStatuses, isTerminalStatus, RESERVATION_STATUSES } from "./reservation-status";

describe("canTransition", () => {
  it("allows the standard happy path: requested -> confirmed -> seated -> completed", () => {
    expect(canTransition("requested", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "seated")).toBe(true);
    expect(canTransition("seated", "completed")).toBe(true);
  });

  it("allows cancellation before seating, but not after", () => {
    expect(canTransition("requested", "cancelled")).toBe(true);
    expect(canTransition("confirmed", "cancelled")).toBe(true);
    expect(canTransition("seated", "cancelled")).toBe(false);
  });

  it("allows no_show only from confirmed, not from requested", () => {
    expect(canTransition("confirmed", "no_show")).toBe(true);
    expect(canTransition("requested", "no_show")).toBe(false);
  });

  it("rejects illegal jumps", () => {
    expect(canTransition("requested", "seated")).toBe(false);
    expect(canTransition("requested", "completed")).toBe(false);
    expect(canTransition("seated", "confirmed")).toBe(false);
  });

  it("never allows a transition out of a terminal status", () => {
    for (const terminal of ["completed", "cancelled", "no_show"] as const) {
      for (const target of RESERVATION_STATUSES) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });
});

describe("nextStatuses / isTerminalStatus", () => {
  it("agrees with canTransition for every status pair", () => {
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        expect(nextStatuses(from).includes(to)).toBe(canTransition(from, to));
      }
    }
  });

  it("flags completed/cancelled/no_show as terminal, others as not", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("no_show")).toBe(true);
    expect(isTerminalStatus("requested")).toBe(false);
    expect(isTerminalStatus("confirmed")).toBe(false);
    expect(isTerminalStatus("seated")).toBe(false);
  });
});
