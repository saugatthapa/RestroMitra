/**
 * Phase 11d: askAssistant() is a real network call to a provider's API,
 * which requires a real API key to actually succeed — so, same pattern as
 * khalti.test.ts, every network-touching test here goes through the
 * injectable `fetchImpl` param instead. buildSystemPrompt() is pure (string
 * formatting only) and is exercised directly.
 *
 * Phase 14: askAssistant() now branches on config.provider, so both the
 * Anthropic Messages API shape and Groq's OpenAI-compatible chat-completions
 * shape are covered below — same assertions, different request/response
 * wire format per provider.
 */
import { describe, it, expect, vi } from "vitest";
import { buildSystemPrompt, askAssistant, AssistantApiError, type ReportSummary } from "./assistant";
import type { AnthropicConfig, GroqConfig } from "./config";

const anthropicTestConfig: AnthropicConfig = {
  provider: "anthropic",
  apiKey: "test-key",
  model: "claude-3-5-haiku-latest",
  apiUrl: "https://api.anthropic.com/v1/messages",
  apiVersion: "2023-06-01",
};

const groqTestConfig: GroqConfig = {
  provider: "groq",
  apiKey: "test-groq-key",
  model: "llama-3.3-70b-versatile",
  apiUrl: "https://api.groq.com/openai/v1/chat/completions",
};

const sampleSummary: ReportSummary = {
  range: { from: "2026-07-16", to: "2026-08-14" },
  sales: {
    revenueInPaisa: 5_000_00,
    orderCount: 42,
    averageOrderValueInPaisa: 11_904,
    cancelledCount: 3,
    discountInPaisa: 50_00,
    serviceChargeInPaisa: 25_00,
  },
  totalExpensesInPaisa: 1_500_00,
  netProfitInPaisa: 3_500_00,
  dailySeries: [],
  topItems: [
    { name: "Chicken Momo", quantitySold: 120, revenueInPaisa: 2_160_00 },
    { name: "Veg Momo", quantitySold: 80, revenueInPaisa: 1_200_00 },
  ],
  paymentBreakdown: [
    { method: "cash", totalInPaisa: 3_000_00 },
    { method: "mobile_wallet", totalInPaisa: 2_000_00 },
  ],
  expenseBreakdown: [{ category: "rent", totalInPaisa: 1_000_00 }, { category: "utilities", totalInPaisa: 500_00 }],
  totalTipsInPaisa: 100_00,
  peakHour: {
    peakOrdersHour: 19,
    peakOrdersCount: 14,
    peakSalesHour: 20,
    peakSalesInPaisa: 85_00,
  },
  completion: {
    completionRatePercent: 92.5,
    avgCompletionMinutes: 28,
  },
  comparison: {
    previousRange: { from: "2026-06-16", to: "2026-07-15" },
    revenueChangePercent: 12.5,
    ordersChangePercent: 8.43,
    avgOrderValueChangePercent: -1.2,
    netProfitChangePercent: 20.1,
  },
  hourlyHeatmap: [{ dayOfWeek: 5, hour: 19, orderCount: 14, revenueInPaisa: 85_00 }],
  branchComparison: [
    {
      branchId: "branch-1",
      branchName: "Main Branch",
      isMain: true,
      revenueInPaisa: 3_500_00,
      orderCount: 30,
      averageOrderValueInPaisa: 11_666,
    },
    {
      branchId: "branch-2",
      branchName: "Airport Road Branch",
      isMain: false,
      revenueInPaisa: 1_500_00,
      orderCount: 12,
      averageOrderValueInPaisa: 12_500,
    },
  ],
};

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response;
}

describe("buildSystemPrompt", () => {
  it("embeds the restaurant name, date range, and formatted figures", () => {
    const prompt = buildSystemPrompt("Phase11d Test Restaurant", sampleSummary);
    expect(prompt).toContain("Phase11d Test Restaurant");
    expect(prompt).toContain("2026-07-16");
    expect(prompt).toContain("2026-08-14");
    expect(prompt).toContain("Rs. 5,000.00"); // revenue
    expect(prompt).toContain("Chicken Momo");
    expect(prompt).toContain("Rent"); // EXPENSE_CATEGORY_LABELS
    expect(prompt).toContain("Cash"); // PAYMENT_METHOD_LABELS
  });

  it("instructs the model to only use the given data", () => {
    const prompt = buildSystemPrompt("Restaurant", sampleSummary);
    expect(prompt.toLowerCase()).toContain("only use the data given below");
  });

  it("handles an empty range gracefully (no crash on zero orders/payments/expenses)", () => {
    const empty: ReportSummary = {
      range: { from: "2026-08-01", to: "2026-08-14" },
      sales: {
        revenueInPaisa: 0,
        orderCount: 0,
        averageOrderValueInPaisa: 0,
        cancelledCount: 0,
        discountInPaisa: 0,
        serviceChargeInPaisa: 0,
      },
      totalExpensesInPaisa: 0,
      netProfitInPaisa: 0,
      dailySeries: [],
      topItems: [],
      paymentBreakdown: [],
      expenseBreakdown: [],
      totalTipsInPaisa: 0,
      peakHour: {
        peakOrdersHour: null,
        peakOrdersCount: 0,
        peakSalesHour: null,
        peakSalesInPaisa: 0,
      },
      completion: {
        completionRatePercent: 0,
        avgCompletionMinutes: null,
      },
      comparison: {
        previousRange: { from: "2026-07-18", to: "2026-07-31" },
        revenueChangePercent: null,
        ordersChangePercent: null,
        avgOrderValueChangePercent: null,
        netProfitChangePercent: null,
      },
      hourlyHeatmap: [],
      branchComparison: [
        {
          branchId: "branch-1",
          branchName: "Main Branch",
          isMain: true,
          revenueInPaisa: 0,
          orderCount: 0,
          averageOrderValueInPaisa: 0,
        },
      ],
    };
    const prompt = buildSystemPrompt("Restaurant", empty);
    expect(prompt).toContain("no completed orders");
    expect(prompt).toContain("no payments recorded");
    expect(prompt).toContain("no expenses recorded");
  });

  it("omits the branch breakdown when there's only one branch, includes it when there are several", () => {
    const singleBranch = buildSystemPrompt("Restaurant", {
      ...sampleSummary,
      branchComparison: [sampleSummary.branchComparison[0]],
    });
    expect(singleBranch).not.toContain("Revenue by branch");

    const multiBranch = buildSystemPrompt("Restaurant", sampleSummary);
    expect(multiBranch).toContain("Revenue by branch");
    expect(multiBranch).toContain("Airport Road Branch");
    expect(multiBranch).toContain("Main Branch (main)");
  });
});

describe("askAssistant (Anthropic provider)", () => {
  it("sends the system prompt and question with the correct auth headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [{ type: "text", text: "Revenue was Rs. 5,000.00 over the last 30 days." }],
        stop_reason: "end_turn",
      }),
    );

    const result = await askAssistant(
      { systemPrompt: "SYSTEM", question: "How were sales?" },
      anthropicTestConfig,
      fetchImpl,
    );

    expect(result.answer).toBe("Revenue was Rs. 5,000.00 over the last 30 days.");
    expect(result.stopReason).toBe("end_turn");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(anthropicTestConfig.apiUrl);
    expect(init.headers["x-api-key"]).toBe("test-key");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-3-5-haiku-latest");
    expect(body.system).toBe("SYSTEM");
    expect(body.messages).toEqual([{ role: "user", content: "How were sales?" }]);
  });

  it("throws AssistantApiError on a non-ok HTTP status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "invalid x-api-key" } }, false, 401));
    await expect(
      askAssistant({ systemPrompt: "S", question: "Q" }, anthropicTestConfig, fetchImpl),
    ).rejects.toBeInstanceOf(AssistantApiError);
  });

  it("throws AssistantApiError when the response has no text content block", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "tool_use" }] }));
    await expect(
      askAssistant({ systemPrompt: "S", question: "Q" }, anthropicTestConfig, fetchImpl),
    ).rejects.toBeInstanceOf(AssistantApiError);
  });

  it("throws AssistantApiError on a malformed response body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }));
    await expect(
      askAssistant({ systemPrompt: "S", question: "Q" }, anthropicTestConfig, fetchImpl),
    ).rejects.toBeInstanceOf(AssistantApiError);
  });
});

describe("askAssistant (Groq provider, default)", () => {
  it("sends the system+user messages with a Bearer auth header, OpenAI-compatible shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: "Revenue was Rs. 5,000.00 over the last 30 days." },
            finish_reason: "stop",
          },
        ],
      }),
    );

    const result = await askAssistant(
      { systemPrompt: "SYSTEM", question: "How were sales?" },
      groqTestConfig,
      fetchImpl,
    );

    expect(result.answer).toBe("Revenue was Rs. 5,000.00 over the last 30 days.");
    expect(result.stopReason).toBe("stop");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(groqTestConfig.apiUrl);
    expect(init.headers.Authorization).toBe("Bearer test-groq-key");
    expect(init.headers["x-api-key"]).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.model).toBe("llama-3.3-70b-versatile");
    // Unlike Anthropic, Groq's OpenAI-compatible API has no top-level
    // `system` field — the system prompt is the first message.
    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "How were sales?" },
    ]);
  });

  it("throws AssistantApiError on a non-ok HTTP status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: "invalid api key" } }, false, 401),
    );
    await expect(
      askAssistant({ systemPrompt: "S", question: "Q" }, groqTestConfig, fetchImpl),
    ).rejects.toBeInstanceOf(AssistantApiError);
  });

  it("throws AssistantApiError when the response has no message content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] }));
    await expect(
      askAssistant({ systemPrompt: "S", question: "Q" }, groqTestConfig, fetchImpl),
    ).rejects.toBeInstanceOf(AssistantApiError);
  });

  it("throws AssistantApiError on a malformed response body (no choices array)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }));
    await expect(
      askAssistant({ systemPrompt: "S", question: "Q" }, groqTestConfig, fetchImpl),
    ).rejects.toBeInstanceOf(AssistantApiError);
  });

  it("defaults to Groq when no config is passed and AI_PROVIDER/GROQ_API_KEY are unset (throws the actionable setup error)", async () => {
    const prevProvider = process.env.AI_PROVIDER;
    const prevGroqKey = process.env.GROQ_API_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_PROVIDER;
    delete process.env.GROQ_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(askAssistant({ systemPrompt: "S", question: "Q" })).rejects.toThrow(
        /GROQ_API_KEY is not set/,
      );
    } finally {
      if (prevProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prevProvider;
      if (prevGroqKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = prevGroqKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }
  });
});
