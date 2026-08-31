import { describe, it, expect } from "vitest";
import { estimateCostInPaisa } from "./cost";

describe("estimateCostInPaisa", () => {
  it("returns 0 for a known free-tier provider/model pair (Groq)", () => {
    expect(estimateCostInPaisa("groq", "llama-3.3-70b-versatile", 1000, 500)).toBe(0);
  });

  it("returns a positive estimate for a known paid pair (Anthropic Haiku)", () => {
    const cost = estimateCostInPaisa("anthropic", "claude-3-5-haiku-latest", 1_000_000, 1_000_000);
    expect(cost).not.toBeNull();
    expect(cost).toBeGreaterThan(0);
  });

  it("scales roughly linearly with token count", () => {
    const small = estimateCostInPaisa("anthropic", "claude-3-5-haiku-latest", 100_000, 100_000)!;
    const large = estimateCostInPaisa("anthropic", "claude-3-5-haiku-latest", 1_000_000, 1_000_000)!;
    expect(large).toBeGreaterThan(small * 5);
  });

  it("returns null (not 0) for an unknown provider/model pair", () => {
    expect(estimateCostInPaisa("openai", "gpt-5", 1000, 1000)).toBeNull();
    expect(estimateCostInPaisa("groq", "some-future-model", 1000, 1000)).toBeNull();
  });

  it("treats missing token counts as 0, not an error", () => {
    expect(estimateCostInPaisa("anthropic", "claude-3-5-haiku-latest", null, null)).toBe(0);
    expect(estimateCostInPaisa("anthropic", "claude-3-5-haiku-latest", undefined, undefined)).toBe(0);
  });
});
