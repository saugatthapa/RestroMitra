import { describe, expect, it } from "vitest";
import { formatOpeningHoursSummary, buildDirectionsUrl, buildSiteUrl } from "./website";

describe("formatOpeningHoursSummary", () => {
  it("returns null when there's no opening-hours data", () => {
    expect(formatOpeningHoursSummary(null)).toBeNull();
    expect(formatOpeningHoursSummary(undefined)).toBeNull();
  });

  it("returns null when every day is closed", () => {
    const allClosed = Object.fromEntries(
      ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [d, null]),
    );
    expect(formatOpeningHoursSummary(allClosed)).toBeNull();
  });

  it("collapses identical hours on all 7 days to one 'Open daily' line", () => {
    const same = Object.fromEntries(
      ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [
        d,
        { open: "09:00", close: "21:00" },
      ]),
    );
    expect(formatOpeningHoursSummary(same)).toBe("Open daily · 9:00 AM – 9:00 PM");
  });

  it("formats midnight and noon correctly (12-hour edge cases)", () => {
    const same = Object.fromEntries(
      ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [
        d,
        { open: "00:00", close: "12:00" },
      ]),
    );
    expect(formatOpeningHoursSummary(same)).toBe("Open daily · 12:00 AM – 12:00 PM");
  });

  it("groups consecutive days with matching hours and shows a closed day separately", () => {
    const hours = {
      monday: { open: "09:00", close: "21:00" },
      tuesday: { open: "09:00", close: "21:00" },
      wednesday: { open: "09:00", close: "21:00" },
      thursday: { open: "09:00", close: "21:00" },
      friday: { open: "09:00", close: "21:00" },
      saturday: { open: "10:00", close: "22:00" },
      sunday: null,
    };
    expect(formatOpeningHoursSummary(hours)).toBe(
      "Mon–Fri: 9:00 AM – 9:00 PM · Sat: 10:00 AM – 10:00 PM · Sun: Closed",
    );
  });

  it("handles a missing day key the same as closed", () => {
    const hours = { monday: { open: "09:00", close: "21:00" } };
    // Only monday is open; every other day key is simply absent from the
    // record — should read as closed, not throw.
    expect(formatOpeningHoursSummary(hours)).toBe("Mon: 9:00 AM – 9:00 PM · Tue–Sun: Closed");
  });
});

describe("buildDirectionsUrl", () => {
  it("builds a Google Maps search URL with the address URL-encoded", () => {
    expect(buildDirectionsUrl("Dharan Road, Itahari-5")).toBe(
      "https://www.google.com/maps/search/?api=1&query=Dharan%20Road%2C%20Itahari-5",
    );
  });
});

describe("buildSiteUrl", () => {
  it("joins the app URL and slug, trimming a trailing slash on the app URL", () => {
    expect(buildSiteUrl("https://example.com/", "my-restaurant")).toBe(
      "https://example.com/site/my-restaurant",
    );
    expect(buildSiteUrl("https://example.com", "my-restaurant")).toBe(
      "https://example.com/site/my-restaurant",
    );
  });
});
