import { describe, it, expect } from "vitest";
import { createReservationSchema, updateReservationSchema, updateReservationStatusSchema } from "./reservations";

describe("createReservationSchema", () => {
  it("accepts a valid reservation", () => {
    const parsed = createReservationSchema.parse({
      customerName: "TEST Hari Bahadur",
      customerPhone: "9812345678",
      partySize: 4,
      reservationTime: "2026-08-20T19:00:00.000Z",
    });
    expect(parsed.customerName).toBe("TEST Hari Bahadur");
    expect(parsed.reservationTime).toBeInstanceOf(Date);
    expect(parsed.durationMinutes).toBeUndefined();
  });

  it("rejects an invalid Nepal phone number", () => {
    expect(() =>
      createReservationSchema.parse({
        customerName: "TEST Name",
        customerPhone: "12345",
        partySize: 2,
        reservationTime: "2026-08-20T19:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a party size below 1", () => {
    expect(() =>
      createReservationSchema.parse({
        customerName: "TEST Name",
        customerPhone: "9812345678",
        partySize: 0,
        reservationTime: "2026-08-20T19:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects an unparseable reservationTime", () => {
    expect(() =>
      createReservationSchema.parse({
        customerName: "TEST Name",
        customerPhone: "9812345678",
        partySize: 2,
        reservationTime: "not-a-date",
      }),
    ).toThrow();
  });

  it("accepts an optional durationMinutes within range", () => {
    const parsed = createReservationSchema.parse({
      customerName: "TEST Name",
      customerPhone: "9812345678",
      partySize: 2,
      reservationTime: "2026-08-20T19:00:00.000Z",
      durationMinutes: 120,
    });
    expect(parsed.durationMinutes).toBe(120);
  });
});

describe("updateReservationSchema", () => {
  it("accepts a partial update", () => {
    const parsed = updateReservationSchema.parse({ partySize: 6 });
    expect(parsed.partySize).toBe(6);
  });

  it("rejects an empty object", () => {
    expect(() => updateReservationSchema.parse({})).toThrow();
  });

  it("accepts tableId: null (explicit un-assignment)", () => {
    const parsed = updateReservationSchema.parse({ tableId: null });
    expect(parsed.tableId).toBeNull();
  });
});

describe("updateReservationStatusSchema", () => {
  it("accepts a valid status", () => {
    expect(updateReservationStatusSchema.parse({ status: "confirmed" }).status).toBe("confirmed");
  });

  it("rejects an unknown status", () => {
    expect(() => updateReservationStatusSchema.parse({ status: "eaten" })).toThrow();
  });
});
