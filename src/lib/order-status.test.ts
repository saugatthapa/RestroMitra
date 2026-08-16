import { describe, it, expect } from "vitest";
import {
  ORDER_STATUSES,
  canTransition,
  nextStatuses,
  nextForwardStatus,
  isTerminalStatus,
} from "./order-status";

describe("order status state machine", () => {
  it("allows the full happy-path pipeline", () => {
    expect(canTransition("pending", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "preparing")).toBe(true);
    expect(canTransition("preparing", "ready")).toBe(true);
    expect(canTransition("ready", "served")).toBe(true);
    expect(canTransition("served", "completed")).toBe(true);
  });

  it("allows cancellation from pending through ready, but not after serving", () => {
    expect(canTransition("pending", "cancelled")).toBe(true);
    expect(canTransition("confirmed", "cancelled")).toBe(true);
    expect(canTransition("preparing", "cancelled")).toBe(true);
    expect(canTransition("ready", "cancelled")).toBe(true);
    expect(canTransition("served", "cancelled")).toBe(false);
    expect(canTransition("completed", "cancelled")).toBe(false);
  });

  it("rejects skipping stages", () => {
    expect(canTransition("pending", "preparing")).toBe(false);
    expect(canTransition("pending", "ready")).toBe(false);
    expect(canTransition("pending", "served")).toBe(false);
    expect(canTransition("pending", "completed")).toBe(false);
    expect(canTransition("confirmed", "served")).toBe(false);
  });

  it("rejects moving backwards", () => {
    expect(canTransition("confirmed", "pending")).toBe(false);
    expect(canTransition("preparing", "confirmed")).toBe(false);
    expect(canTransition("completed", "served")).toBe(false);
  });

  it("treats completed and cancelled as terminal", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(nextStatuses("completed")).toEqual([]);
    expect(nextStatuses("cancelled")).toEqual([]);
  });

  it("treats every non-terminal status as non-terminal", () => {
    for (const status of ORDER_STATUSES) {
      if (status === "completed" || status === "cancelled") continue;
      expect(isTerminalStatus(status)).toBe(false);
      expect(nextStatuses(status).length).toBeGreaterThan(0);
    }
  });

  it("nextForwardStatus skips cancellation and returns null once terminal", () => {
    expect(nextForwardStatus("pending")).toBe("confirmed");
    expect(nextForwardStatus("confirmed")).toBe("preparing");
    expect(nextForwardStatus("preparing")).toBe("ready");
    expect(nextForwardStatus("ready")).toBe("served");
    expect(nextForwardStatus("served")).toBe("completed");
    expect(nextForwardStatus("completed")).toBeNull();
    expect(nextForwardStatus("cancelled")).toBeNull();
  });
});
