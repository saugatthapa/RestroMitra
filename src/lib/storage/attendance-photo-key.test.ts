import { describe, it, expect } from "vitest";
import { buildAttendancePhotoKey, isAttendancePhotoKeyFor } from "./attendance-photo-key";

const restaurantId = "11111111-1111-1111-1111-111111111111";
const userId = "22222222-2222-2222-2222-222222222222";
const otherRestaurantId = "33333333-3333-3333-3333-333333333333";
const otherUserId = "44444444-4444-4444-4444-444444444444";

describe("attendance-photo-key", () => {
  it("a key built for (restaurant, user, kind) validates for that exact triple", () => {
    const key = buildAttendancePhotoKey({ restaurantId, userId, kind: "clock_in", token: "abc123XYZ_-token1" });
    expect(isAttendancePhotoKeyFor(key, { restaurantId, userId, kind: "clock_in" })).toBe(true);
  });

  it("rejects the same key for a different restaurant — prevents one tenant's key being replayed onto another", () => {
    const key = buildAttendancePhotoKey({ restaurantId, userId, kind: "clock_in", token: "abc123XYZ_-token1" });
    expect(isAttendancePhotoKeyFor(key, { restaurantId: otherRestaurantId, userId, kind: "clock_in" })).toBe(
      false,
    );
  });

  it("rejects the same key for a different user — prevents one person's key being claimed by another", () => {
    const key = buildAttendancePhotoKey({ restaurantId, userId, kind: "clock_in", token: "abc123XYZ_-token1" });
    expect(isAttendancePhotoKeyFor(key, { restaurantId, userId: otherUserId, kind: "clock_in" })).toBe(false);
  });

  it("rejects a clock_in key presented for a clock_out request", () => {
    const key = buildAttendancePhotoKey({ restaurantId, userId, kind: "clock_in", token: "abc123XYZ_-token1" });
    expect(isAttendancePhotoKeyFor(key, { restaurantId, userId, kind: "clock_out" })).toBe(false);
  });

  it("rejects a malformed / made-up key string outright", () => {
    expect(
      isAttendancePhotoKeyFor("not-even-close-to-a-real-key.jpg", { restaurantId, userId, kind: "clock_in" }),
    ).toBe(false);
    expect(
      isAttendancePhotoKeyFor(`attendance-photos/${restaurantId}/${userId}/clock_in/../../etc/passwd`, {
        restaurantId,
        userId,
        kind: "clock_in",
      }),
    ).toBe(false);
  });

  it("two keys minted for the same triple at different times/tokens never collide", () => {
    const keyA = buildAttendancePhotoKey({ restaurantId, userId, kind: "clock_in", token: "tokenAAAAAAAAAAAA" });
    const keyB = buildAttendancePhotoKey({ restaurantId, userId, kind: "clock_in", token: "tokenBBBBBBBBBBBB" });
    expect(keyA).not.toBe(keyB);
    expect(isAttendancePhotoKeyFor(keyA, { restaurantId, userId, kind: "clock_in" })).toBe(true);
    expect(isAttendancePhotoKeyFor(keyB, { restaurantId, userId, kind: "clock_in" })).toBe(true);
  });

  // P2 gap-audit fix — the two "_workplace" kinds for the separate
  // workplace/surroundings photo share this exact same parser/builder;
  // these confirm they're validated as their own distinct kind rather
  // than accidentally matching (or being matched by) the selfie kinds.
  describe("workplace photo kinds", () => {
    it("a key built for clock_in_workplace validates for that exact kind", () => {
      const key = buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in_workplace",
        token: "abc123XYZ_-token1",
      });
      expect(isAttendancePhotoKeyFor(key, { restaurantId, userId, kind: "clock_in_workplace" })).toBe(true);
    });

    it("a clock_in_workplace key is rejected for the plain clock_in (selfie) kind, and vice versa", () => {
      const workplaceKey = buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in_workplace",
        token: "abc123XYZ_-token1",
      });
      expect(isAttendancePhotoKeyFor(workplaceKey, { restaurantId, userId, kind: "clock_in" })).toBe(false);

      const selfieKey = buildAttendancePhotoKey({ restaurantId, userId, kind: "clock_in", token: "abc123XYZ_-token1" });
      expect(isAttendancePhotoKeyFor(selfieKey, { restaurantId, userId, kind: "clock_in_workplace" })).toBe(false);
    });

    it("a clock_in_workplace key is rejected for clock_out_workplace", () => {
      const key = buildAttendancePhotoKey({
        restaurantId,
        userId,
        kind: "clock_in_workplace",
        token: "abc123XYZ_-token1",
      });
      expect(isAttendancePhotoKeyFor(key, { restaurantId, userId, kind: "clock_out_workplace" })).toBe(false);
    });
  });
});
