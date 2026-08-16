import { describe, it, expect } from "vitest";
import {
  PAYMENT_METHODS,
  computeNetPaid,
  computePaymentStatus,
  computeRemainingDue,
  computeBillingSummary,
  computeTipTotal,
} from "./payments";

describe("computeNetPaid", () => {
  it("sums a set of payments", () => {
    expect(computeNetPaid([50_000, 30_000, 20_000])).toBe(100_000);
  });

  it("nets refunds (negative amounts) out automatically", () => {
    expect(computeNetPaid([100_000, -40_000])).toBe(60_000);
  });

  it("returns 0 for no payments", () => {
    expect(computeNetPaid([])).toBe(0);
  });

  it("can go negative if refunds exceed payments (shouldn't happen in practice, but the math itself doesn't clamp)", () => {
    expect(computeNetPaid([10_000, -25_000])).toBe(-15_000);
  });
});

describe("computePaymentStatus", () => {
  it("is unpaid when nothing has been paid", () => {
    expect(computePaymentStatus(100_000, 0)).toBe("unpaid");
  });

  it("is partially_paid when some but not all has been paid", () => {
    expect(computePaymentStatus(100_000, 40_000)).toBe("partially_paid");
  });

  it("is paid when the net paid meets the total exactly", () => {
    expect(computePaymentStatus(100_000, 100_000)).toBe("paid");
  });

  it("is paid when the net paid exceeds the total (e.g. a tip/overage recorded as part of the amount)", () => {
    expect(computePaymentStatus(100_000, 120_000)).toBe("paid");
  });

  it("treats a zero-total order as unpaid, never paid, even with zero net paid", () => {
    // Guards against the netPaid >= total check trivially being true when
    // both sides are 0 — a real order always has a positive total, but the
    // function itself should not silently call a degenerate case "paid".
    expect(computePaymentStatus(0, 0)).toBe("unpaid");
  });

  it("drops back to unpaid once a full refund brings net paid back to zero or below", () => {
    const netPaidAfterFullRefund = computeNetPaid([100_000, -100_000]);
    expect(computePaymentStatus(100_000, netPaidAfterFullRefund)).toBe("unpaid");
  });

  it("is partially_paid after a partial refund that still leaves something paid", () => {
    const netPaidAfterPartialRefund = computeNetPaid([100_000, -30_000]);
    expect(computePaymentStatus(100_000, netPaidAfterPartialRefund)).toBe("partially_paid");
  });
});

describe("computeRemainingDue", () => {
  it("is the full total when nothing has been paid", () => {
    expect(computeRemainingDue(100_000, 0)).toBe(100_000);
  });

  it("shrinks as payments come in", () => {
    expect(computeRemainingDue(100_000, 60_000)).toBe(40_000);
  });

  it("never goes negative, even if overpaid", () => {
    expect(computeRemainingDue(100_000, 150_000)).toBe(0);
  });

  it("is exactly zero once fully paid", () => {
    expect(computeRemainingDue(100_000, 100_000)).toBe(0);
  });
});

describe("computeBillingSummary", () => {
  it("combines all three derivations consistently for a split bill (two payments, no refund)", () => {
    const summary = computeBillingSummary(100_000, [60_000, 40_000]);
    expect(summary).toEqual({
      totalInPaisa: 100_000,
      netPaidInPaisa: 100_000,
      remainingDueInPaisa: 0,
      paymentStatus: "paid",
      tipTotalInPaisa: 0,
    });
  });

  it("reflects a partial payment", () => {
    const summary = computeBillingSummary(100_000, [25_000]);
    expect(summary).toEqual({
      totalInPaisa: 100_000,
      netPaidInPaisa: 25_000,
      remainingDueInPaisa: 75_000,
      paymentStatus: "partially_paid",
      tipTotalInPaisa: 0,
    });
  });

  it("reflects a fully paid order that was then partially refunded", () => {
    const summary = computeBillingSummary(100_000, [100_000, -50_000]);
    expect(summary).toEqual({
      totalInPaisa: 100_000,
      netPaidInPaisa: 50_000,
      remainingDueInPaisa: 50_000,
      paymentStatus: "partially_paid",
      tipTotalInPaisa: 0,
    });
  });

  it("handles an order with no payments at all", () => {
    const summary = computeBillingSummary(100_000, []);
    expect(summary).toEqual({
      totalInPaisa: 100_000,
      netPaidInPaisa: 0,
      remainingDueInPaisa: 100_000,
      paymentStatus: "unpaid",
      tipTotalInPaisa: 0,
    });
  });

  it("sums tips independently of the payment/remaining-due math (Phase 13)", () => {
    const summary = computeBillingSummary(100_000, [60_000], [5_000, 3_000]);
    expect(summary).toEqual({
      totalInPaisa: 100_000,
      netPaidInPaisa: 60_000,
      remainingDueInPaisa: 40_000,
      paymentStatus: "partially_paid",
      tipTotalInPaisa: 8_000,
    });
  });
});

describe("computeTipTotal", () => {
  it("sums tips across payments", () => {
    expect(computeTipTotal([5_000, 2_000, 1_000])).toBe(8_000);
  });

  it("returns 0 for no tips", () => {
    expect(computeTipTotal([])).toBe(0);
  });
});

describe("PAYMENT_METHODS", () => {
  it("is the fixed set of four methods the schema enum and validation both key off of", () => {
    expect(PAYMENT_METHODS).toEqual(["cash", "card", "mobile_wallet", "other"]);
  });
});
