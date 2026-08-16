import { describe, it, expect, afterEach } from "vitest";
import { getAnthropicConfig } from "./config";

const ORIGINAL_ENV = { ...process.env };

describe("getAnthropicConfig", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws an actionable error when ANTHROPIC_API_KEY is unset", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getAnthropicConfig()).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it("returns a config with the default model when ANTHROPIC_MODEL is unset", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.ANTHROPIC_MODEL;
    const config = getAnthropicConfig();
    expect(config.apiKey).toBe("test-key");
    expect(config.model).toBe("claude-3-5-haiku-latest");
    expect(config.apiUrl).toBe("https://api.anthropic.com/v1/messages");
  });

  it("respects an ANTHROPIC_MODEL override", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_MODEL = "claude-opus-4-1";
    expect(getAnthropicConfig().model).toBe("claude-opus-4-1");
  });
});
