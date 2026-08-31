import { describe, it, expect } from "vitest";
import { isAnnouncementCurrentlyShowable } from "./announcements";

const NOW = new Date("2026-08-31T12:00:00Z");

describe("isAnnouncementCurrentlyShowable", () => {
  it("an active announcement with no window is always showable", () => {
    expect(
      isAnnouncementCurrentlyShowable({ isActive: true, startsAt: null, endsAt: null }, NOW),
    ).toBe(true);
  });

  it("an inactive announcement is never showable, regardless of window", () => {
    expect(
      isAnnouncementCurrentlyShowable({ isActive: false, startsAt: null, endsAt: null }, NOW),
    ).toBe(false);
  });

  it("not yet showable before its startsAt", () => {
    expect(
      isAnnouncementCurrentlyShowable(
        { isActive: true, startsAt: new Date("2026-09-01T00:00:00Z"), endsAt: null },
        NOW,
      ),
    ).toBe(false);
  });

  it("showable once startsAt has passed", () => {
    expect(
      isAnnouncementCurrentlyShowable(
        { isActive: true, startsAt: new Date("2026-08-01T00:00:00Z"), endsAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it("no longer showable after endsAt", () => {
    expect(
      isAnnouncementCurrentlyShowable(
        { isActive: true, startsAt: null, endsAt: new Date("2026-08-30T00:00:00Z") },
        NOW,
      ),
    ).toBe(false);
  });

  it("showable while within both bounds", () => {
    expect(
      isAnnouncementCurrentlyShowable(
        {
          isActive: true,
          startsAt: new Date("2026-08-01T00:00:00Z"),
          endsAt: new Date("2026-09-30T00:00:00Z"),
        },
        NOW,
      ),
    ).toBe(true);
  });
});
