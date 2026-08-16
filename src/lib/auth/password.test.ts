import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, validatePasswordStrength } from "./password";

describe("password hashing", () => {
  it("hashes and verifies a correct password", async () => {
    const hash = await hashPassword("correcthorse123");
    expect(hash).not.toBe("correcthorse123");
    await expect(verifyPassword("correcthorse123", hash)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correcthorse123");
    await expect(verifyPassword("wrongpassword1", hash)).resolves.toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const a = await hashPassword("samepassword1");
    const b = await hashPassword("samepassword1");
    expect(a).not.toBe(b);
  });
});

describe("password strength validation", () => {
  it("rejects short passwords", () => {
    expect(validatePasswordStrength("ab1")).toBeTruthy();
  });

  it("rejects letters-only passwords", () => {
    expect(validatePasswordStrength("onlyletters")).toBeTruthy();
  });

  it("rejects numbers-only passwords", () => {
    expect(validatePasswordStrength("12345678")).toBeTruthy();
  });

  it("accepts a reasonable password", () => {
    expect(validatePasswordStrength("goodpass123")).toBeNull();
  });
});
