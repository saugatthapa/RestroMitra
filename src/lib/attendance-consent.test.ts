import { describe, it, expect } from "vitest";
import { CURRENT_CONSENT_VERSION, hasCurrentConsent } from "./attendance-consent";

describe("hasCurrentConsent", () => {
  it("true when the record's version matches CURRENT_CONSENT_VERSION", () => {
    expect(hasCurrentConsent({ consentVersion: CURRENT_CONSENT_VERSION })).toBe(true);
  });

  it("false for an older version — a notice-text change requires fresh consent", () => {
    expect(hasCurrentConsent({ consentVersion: "2020-01-v1" })).toBe(false);
  });

  it("false for null/undefined — never consented at all", () => {
    expect(hasCurrentConsent(null)).toBe(false);
    expect(hasCurrentConsent(undefined)).toBe(false);
  });
});
