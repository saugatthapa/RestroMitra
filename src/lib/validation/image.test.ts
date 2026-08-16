import { describe, it, expect } from "vitest";
import { imageUrlSchema } from "./image";
import { createRestaurantSchema } from "./onboarding";

describe("imageUrlSchema (shared by menu item photos and restaurant logos)", () => {
  const schema = imageUrlSchema();

  it("accepts an empty string", () => {
    expect(schema.safeParse("").success).toBe(true);
  });

  it("accepts a plain https:// URL", () => {
    expect(schema.safeParse("https://example.com/logo.png").success).toBe(true);
  });

  it("accepts a data:image/jpeg;base64 URL (what the client-side upload produces)", () => {
    expect(
      schema.safeParse("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD").success,
    ).toBe(true);
  });

  it("rejects a non-image data: URL", () => {
    expect(
      schema.safeParse("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==").success,
    ).toBe(false);
  });

  it("rejects a bare string that's neither a URL nor a data: URL", () => {
    expect(schema.safeParse("not-a-url").success).toBe(false);
  });

  it("rejects a payload over the max size", () => {
    const tiny = imageUrlSchema(10);
    expect(tiny.safeParse("https://example.com/a-fairly-long-path.png").success).toBe(false);
  });
});

const baseRestaurant = {
  name: "Momo House Itahari",
  type: "restaurant" as const,
  address: "Main Road",
  city: "Itahari",
  district: "Sunsari",
  phone: "9812345678",
  openTime: "08:00",
  closeTime: "21:00",
};

describe("createRestaurantSchema logoUrl (onboarding)", () => {
  it("accepts an omitted logoUrl", () => {
    expect(createRestaurantSchema.safeParse(baseRestaurant).success).toBe(true);
  });

  it("accepts an empty string (explicitly no logo)", () => {
    expect(
      createRestaurantSchema.safeParse({ ...baseRestaurant, logoUrl: "" }).success,
    ).toBe(true);
  });

  it("accepts a client-compressed data: URL logo upload", () => {
    expect(
      createRestaurantSchema.safeParse({
        ...baseRestaurant,
        logoUrl: "data:image/png;base64,iVBORw0KGgo",
      }).success,
    ).toBe(true);
  });

  it("rejects a garbage logoUrl", () => {
    expect(
      createRestaurantSchema.safeParse({ ...baseRestaurant, logoUrl: "not-a-url" }).success,
    ).toBe(false);
  });
});
