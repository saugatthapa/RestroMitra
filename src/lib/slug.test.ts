import { describe, it, expect } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Momo House Itahari")).toBe("momo-house-itahari");
  });

  it("strips punctuation", () => {
    expect(slugify("Sita's Café & Bar!!")).toBe("sita-s-caf-bar");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  --Hello World--  ")).toBe("hello-world");
  });

  it("truncates very long names", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
});
