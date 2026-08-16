import { describe, it, expect } from "vitest";
import { buildKotStationTickets, resolveKotHeaderText, type KotTicketItem } from "./kot-ticket";
import { UNASSIGNED_STATION_ID, UNASSIGNED_STATION_NAME } from "@/lib/kds";

function item(overrides: Partial<KotTicketItem>): KotTicketItem {
  return {
    id: "item-1",
    menuItemNameSnapshot: "Chicken Momo",
    variantNameSnapshot: null,
    quantity: 1,
    notes: null,
    addons: [],
    kitchenStationId: null,
    kitchenStationNameSnapshot: null,
    ...overrides,
  };
}

describe("buildKotStationTickets", () => {
  it("returns one ticket per distinct station", () => {
    const items = [
      item({ id: "1", kitchenStationId: "momo", kitchenStationNameSnapshot: "Momo Station" }),
      item({ id: "2", kitchenStationId: "bar", kitchenStationNameSnapshot: "Bar" }),
      item({ id: "3", kitchenStationId: "momo", kitchenStationNameSnapshot: "Momo Station" }),
    ];
    const tickets = buildKotStationTickets(items);
    expect(tickets).toHaveLength(2);
    const momoTicket = tickets.find((t) => t.station.id === "momo");
    expect(momoTicket?.items.map((i) => i.id)).toEqual(["1", "3"]);
    const barTicket = tickets.find((t) => t.station.id === "bar");
    expect(barTicket?.items.map((i) => i.id)).toEqual(["2"]);
  });

  it("groups items with no station under the Unassigned catch-all", () => {
    const items = [item({ id: "1", kitchenStationId: null, kitchenStationNameSnapshot: null })];
    const tickets = buildKotStationTickets(items);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].station).toEqual({ id: UNASSIGNED_STATION_ID, name: UNASSIGNED_STATION_NAME });
  });

  it("returns an empty array for an order with no items", () => {
    expect(buildKotStationTickets([])).toEqual([]);
  });
});

describe("resolveKotHeaderText", () => {
  it("uses the custom header text when set", () => {
    expect(resolveKotHeaderText({ name: "Img Restaurant", kotHeaderText: "Kitchen Copy" })).toBe(
      "Kitchen Copy",
    );
  });

  it("falls back to the restaurant name when kotHeaderText is null", () => {
    expect(resolveKotHeaderText({ name: "Img Restaurant", kotHeaderText: null })).toBe(
      "Img Restaurant",
    );
  });

  it("falls back to the restaurant name when kotHeaderText is blank/whitespace-only", () => {
    expect(resolveKotHeaderText({ name: "Img Restaurant", kotHeaderText: "   " })).toBe(
      "Img Restaurant",
    );
  });

  it("trims surrounding whitespace off a custom header", () => {
    expect(resolveKotHeaderText({ name: "Img Restaurant", kotHeaderText: "  Kitchen  " })).toBe(
      "Kitchen",
    );
  });
});
