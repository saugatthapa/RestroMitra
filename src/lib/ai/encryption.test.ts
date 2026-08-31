import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import { encryptSecret, decryptSecret } from "./encryption";

const ORIGINAL_ENV = { ...process.env };

function freshKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

describe("encryptSecret / decryptSecret", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("round-trips a plaintext value", () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = freshKey();
    const encrypted = encryptSecret("sk-super-secret-key");
    expect(decryptSecret(encrypted)).toBe("sk-super-secret-key");
  });

  it("produces a different ciphertext each time (random IV) even for the same plaintext", () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = freshKey();
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("throws an actionable error when AI_CONFIG_ENCRYPTION_KEY is unset", () => {
    delete process.env.AI_CONFIG_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/AI_CONFIG_ENCRYPTION_KEY is not set/);
  });

  it("throws when AI_CONFIG_ENCRYPTION_KEY doesn't decode to exactly 32 bytes", () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
    expect(() => encryptSecret("x")).toThrow(/exactly 32 bytes/);
  });

  it("fails to decrypt under a different key (GCM auth tag mismatch)", () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = freshKey();
    const encrypted = encryptSecret("sk-super-secret-key");
    process.env.AI_CONFIG_ENCRYPTION_KEY = freshKey();
    expect(() => decryptSecret(encrypted)).toThrow();
  });

  it("fails to decrypt tampered ciphertext", () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = freshKey();
    const encrypted = encryptSecret("sk-super-secret-key");
    const raw = Buffer.from(encrypted, "base64");
    raw[raw.length - 1] ^= 0xff; // flip the last byte
    expect(() => decryptSecret(raw.toString("base64"))).toThrow();
  });
});
