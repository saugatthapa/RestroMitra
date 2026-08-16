import { describe, it, expect } from "vitest";
import { createMenuItemSchema, updateMenuItemSchema } from "./menu";

const baseItem = {
  categoryId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  name: "Chicken Momo",
  price: 180,
};

describe("menu item imageUrl validation (Phase 15)", () => {
  it("accepts an omitted imageUrl", () => {
    const result = createMenuItemSchema.safeParse(baseItem);
    expect(result.success).toBe(true);
  });

  it("accepts an empty string (explicitly no image)", () => {
    const result = createMenuItemSchema.safeParse({ ...baseItem, imageUrl: "" });
    expect(result.success).toBe(true);
  });

  it("accepts a plain https:// URL", () => {
    const result = createMenuItemSchema.safeParse({
      ...baseItem,
      imageUrl: "https://example.com/photos/momo.jpg",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a plain http:// URL", () => {
    const result = createMenuItemSchema.safeParse({
      ...baseItem,
      imageUrl: "http://example.com/momo.jpg",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a data:image/jpeg;base64 URL (what the client-side upload produces)", () => {
    const result = createMenuItemSchema.safeParse({
      ...baseItem,
      imageUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD",
    });
    expect(result.success).toBe(true);
  });

  it("accepts data:image/png and data:image/webp too", () => {
    expect(
      createMenuItemSchema.safeParse({ ...baseItem, imageUrl: "data:image/png;base64,iVBORw0KGgo" })
        .success,
    ).toBe(true);
    expect(
      createMenuItemSchema.safeParse({ ...baseItem, imageUrl: "data:image/webp;base64,UklGRg" }).success,
    ).toBe(true);
  });

  it("rejects a non-image data: URL (e.g. text/html — not something canvas re-encoding would ever produce)", () => {
    const result = createMenuItemSchema.safeParse({
      ...baseItem,
      imageUrl: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bare string that's neither a URL nor a data: URL", () => {
    const result = createMenuItemSchema.safeParse({ ...baseItem, imageUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("rejects a javascript: pseudo-URL", () => {
    const result = createMenuItemSchema.safeParse({
      ...baseItem,
      imageUrl: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized image string past the 2,000,000-char backstop", () => {
    const huge = "data:image/jpeg;base64," + "A".repeat(2_000_000);
    const result = createMenuItemSchema.safeParse({ ...baseItem, imageUrl: huge });
    expect(result.success).toBe(false);
  });

  it("updateMenuItemSchema applies the same rules", () => {
    expect(updateMenuItemSchema.safeParse({ imageUrl: "https://example.com/x.png" }).success).toBe(
      true,
    );
    expect(updateMenuItemSchema.safeParse({ imageUrl: "not-a-url" }).success).toBe(false);
    expect(updateMenuItemSchema.safeParse({}).success).toBe(true);
  });
});
