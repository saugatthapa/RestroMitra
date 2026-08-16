import { describe, it, expect } from "vitest";
import {
  isKitchenTransition,
  stationForItem,
  distinctStations,
  itemsForStation,
  UNASSIGNED_STATION_ID,
  UNASSIGNED_STATION_NAME,
  KDS_VISIBLE_STATUSES,
} from "./kds";

describe("isKitchenTransition", () => {
  it("allows the two kitchen-driven transitions", () => {
    expect(isKitchenTransition("confirmed", "preparing")).toBe(true);
    expect(isKitchenTransition("preparing", "ready")).toBe(true);
  });

  it("rejects front-of-house-only transitions, even though they're legal order-status moves", () => {
    expect(isKitchenTransition("pending", "confirmed")).toBe(false);
    expect(isKitchenTransition("ready", "served")).toBe(false);
    expect(isKitchenTransition("served", "completed")).toBe(false);
  });

  it("rejects cancellation regardless of the starting status", () => {
    expect(isKitchenTransition("pending", "cancelled")).toBe(false);
    expect(isKitchenTransition("confirmed", "cancelled")).toBe(false);
    expect(isKitchenTransition("preparing", "cancelled")).toBe(false);
    expect(isKitchenTransition("ready", "cancelled")).toBe(false);
  });

  it("rejects reversed or skipped kitchen moves", () => {
    expect(isKitchenTransition("preparing", "confirmed")).toBe(false);
    expect(isKitchenTransition("confirmed", "ready")).toBe(false);
    expect(isKitchenTransition("ready", "preparing")).toBe(false);
  });
});

describe("KDS_VISIBLE_STATUSES", () => {
  it("shows exactly the three statuses the kitchen has work to do on", () => {
    expect(KDS_VISIBLE_STATUSES).toEqual(["confirmed", "preparing", "ready"]);
  });

  it("excludes pending (not yet accepted) and terminal statuses", () => {
    expect(KDS_VISIBLE_STATUSES).not.toContain("pending");
    expect(KDS_VISIBLE_STATUSES).not.toContain("served");
    expect(KDS_VISIBLE_STATUSES).not.toContain("completed");
    expect(KDS_VISIBLE_STATUSES).not.toContain("cancelled");
  });
});

describe("stationForItem", () => {
  it("resolves the real station when both id and name snapshot are present", () => {
    expect(
      stationForItem({ kitchenStationId: "station-1", kitchenStationNameSnapshot: "Grill" }),
    ).toEqual({ id: "station-1", name: "Grill" });
  });

  it("falls back to Unassigned when the item has no kitchen station set", () => {
    expect(stationForItem({ kitchenStationId: null, kitchenStationNameSnapshot: null })).toEqual({
      id: UNASSIGNED_STATION_ID,
      name: UNASSIGNED_STATION_NAME,
    });
  });

  it("falls back to Unassigned if only one of id/name snapshot is somehow present (defensive)", () => {
    expect(
      stationForItem({ kitchenStationId: "station-1", kitchenStationNameSnapshot: null }),
    ).toEqual({ id: UNASSIGNED_STATION_ID, name: UNASSIGNED_STATION_NAME });
  });
});

describe("distinctStations", () => {
  it("dedupes stations across items and sorts alphabetically by name", () => {
    const items = [
      { kitchenStationId: "s2", kitchenStationNameSnapshot: "Grill" },
      { kitchenStationId: "s1", kitchenStationNameSnapshot: "Bar" },
      { kitchenStationId: "s2", kitchenStationNameSnapshot: "Grill" },
      { kitchenStationId: "s3", kitchenStationNameSnapshot: "Dessert" },
    ];
    expect(distinctStations(items)).toEqual([
      { id: "s1", name: "Bar" },
      { id: "s3", name: "Dessert" },
      { id: "s2", name: "Grill" },
    ]);
  });

  it("always places Unassigned last, regardless of how it would alphabetize", () => {
    const items = [
      { kitchenStationId: null, kitchenStationNameSnapshot: null },
      { kitchenStationId: "s1", kitchenStationNameSnapshot: "Zebra Station" },
    ];
    expect(distinctStations(items)).toEqual([
      { id: "s1", name: "Zebra Station" },
      { id: UNASSIGNED_STATION_ID, name: UNASSIGNED_STATION_NAME },
    ]);
  });

  it("returns an empty array for no items", () => {
    expect(distinctStations([])).toEqual([]);
  });
});

describe("itemsForStation", () => {
  const items = [
    { id: "i1", kitchenStationId: "s1", kitchenStationNameSnapshot: "Bar" },
    { id: "i2", kitchenStationId: "s2", kitchenStationNameSnapshot: "Grill" },
    { id: "i3", kitchenStationId: null, kitchenStationNameSnapshot: null },
  ];

  it("filters to just the items belonging to the given station", () => {
    expect(itemsForStation(items, "s1")).toEqual([items[0]]);
    expect(itemsForStation(items, "s2")).toEqual([items[1]]);
  });

  it("the Unassigned bucket catches items with no station set", () => {
    expect(itemsForStation(items, UNASSIGNED_STATION_ID)).toEqual([items[2]]);
  });

  it("returns an empty array for a station with no matching items", () => {
    expect(itemsForStation(items, "nonexistent")).toEqual([]);
  });
});
