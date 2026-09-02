import "server-only";
import { formatNPR } from "@/lib/money";
import { PAYMENT_METHOD_LABELS } from "@/lib/payments";
import type { getReportSummary } from "@/lib/reports";
import { ORDER_STATUS_LABELS } from "@/lib/order-status";
import { getAiConfig, type AiConfig, type AnthropicConfig, type GroqConfig } from "./config";

/**
 * Phase 11d — the owner/manager analytics assistant.
 *
 * Deliberately NOT "give the LLM a database connection / let it write
 * SQL." That would mean either re-deriving tenant isolation and permission
 * checks inside a prompt (fragile — a clever enough question becomes a
 * prompt-injection path to another restaurant's data) or trusting the
 * model to always scope its own queries correctly (it won't, reliably).
 * Instead: the SAME computed summary the Reports dashboard already shows
 * (getReportSummary — Phase 9, tenant-scoped by construction since the
 * caller already resolved restaurantId server-side) is serialized into the
 * system prompt as the assistant's entire universe of facts, and the model
 * is explicitly instructed to answer only from it. The assistant can be
 * wrong about which facts matter to the question, but it cannot leak data
 * it was never given in the first place.
 */

export type ReportSummary = Awaited<ReturnType<typeof getReportSummary>>;

function formatHourOfDay(hour: number | null): string {
  if (hour === null) return "n/a";
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour} ${period}`;
}

export function buildSystemPrompt(restaurantName: string, summary: ReportSummary): string {
  const {
    sales,
    totalExpensesInPaisa,
    netProfitInPaisa,
    topItems,
    paymentBreakdown,
    expenseBreakdown,
    totalTipsInPaisa,
    peakHour,
    completion,
    comparison,
    hourlyHeatmap,
    branchComparison,
    orderPerformance,
    range,
  } = summary;

  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const topDayHourCombos = [...hourlyHeatmap]
    .sort((a, b) => b.orderCount - a.orderCount)
    .slice(0, 3)
    .filter((c) => c.orderCount > 0)
    .map((c) => `${DAY_NAMES[c.dayOfWeek]} ${formatHourOfDay(c.hour)} (${c.orderCount} orders, ${formatNPR(c.revenueInPaisa)})`);

  // Only worth mentioning as a "comparison" once there's more than one
  // branch — every restaurant gets one branch at onboarding even if
  // multi-branch is never used, so a length-1 result is the common case.
  const branchText =
    branchComparison.length > 1
      ? branchComparison
          .map(
            (b) =>
              `${b.branchName}${b.isMain ? " (main)" : ""}: ${formatNPR(b.revenueInPaisa)} revenue, ${b.orderCount} orders, ${formatNPR(b.averageOrderValueInPaisa)} avg order value`,
          )
          .join("\n")
      : null;

  const formatChange = (percent: number | null) =>
    percent === null ? "new (no data in the previous period to compare against)" : `${percent > 0 ? "+" : ""}${percent}%`;

  const topItemsText =
    topItems.length > 0
      ? topItems
          .map(
            (item, i) =>
              `${i + 1}. ${item.name} — ${item.quantitySold} sold, ${formatNPR(item.revenueInPaisa)} revenue`,
          )
          .join("\n")
      : "(no completed orders in this range)";

  const paymentText =
    paymentBreakdown.length > 0
      ? paymentBreakdown
          .map((p) => `${PAYMENT_METHOD_LABELS[p.method]}: ${formatNPR(p.totalInPaisa)}`)
          .join("\n")
      : "(no payments recorded in this range)";

  const expenseText =
    expenseBreakdown.length > 0
      ? expenseBreakdown
          .map((e) => `${e.category}: ${formatNPR(e.totalInPaisa)}`)
          .join("\n")
      : "(no expenses recorded in this range)";

  const stageDurationText = orderPerformance.stageDurations
    .filter((s) => s.transitionCount > 0)
    .map(
      (s) =>
        `${ORDER_STATUS_LABELS[s.fromStatus]} -> ${ORDER_STATUS_LABELS[s.toStatus]}: avg ${s.avgMinutes} min (${s.transitionCount} orders)`,
    )
    .join("\n");

  const cancellationReasonText = orderPerformance.cancellationReasons
    .map((r) => `${r.reason}: ${r.count}`)
    .join("; ");

  const staffThroughputText = orderPerformance.staffThroughput
    .map((s) => `${s.staffName}: ${s.completedOrders} orders, ${formatNPR(s.revenueInPaisa)}`)
    .join("; ");

  return `You are the analytics assistant built into RestroKendra, a restaurant management system, answering questions for the owner/manager of "${restaurantName}" — a restaurant in Nepal.

You may ONLY use the data given below, which covers ${range.from} to ${range.to} (inclusive). Do not invent, estimate, or assume any figure that is not explicitly present here. If the question asks about something outside this data (a different date range, a specific customer, inventory/stock levels, staff details, anything not listed below), say plainly that you don't have that information in this view, rather than guessing.

=== DATA (${range.from} to ${range.to}) ===
Completed orders: ${sales.orderCount}
Cancelled orders: ${sales.cancelledCount}
Revenue (completed orders): ${formatNPR(sales.revenueInPaisa)}
Average order value: ${formatNPR(sales.averageOrderValueInPaisa)}
Total expenses: ${formatNPR(totalExpensesInPaisa)}
Net profit (revenue - expenses): ${formatNPR(netProfitInPaisa)}
Discounts given: ${formatNPR(sales.discountInPaisa)}
Service charge collected: ${formatNPR(sales.serviceChargeInPaisa)}
Tips collected: ${formatNPR(totalTipsInPaisa)}

Top-selling items (by revenue):
${topItemsText}

Payments received by method:
${paymentText}

Expenses by category:
${expenseText}

Busiest hour by order count (summed across every day in range): ${formatHourOfDay(peakHour.peakOrdersHour)} (${peakHour.peakOrdersCount} orders)
Busiest hour by revenue (summed across every day in range): ${formatHourOfDay(peakHour.peakSalesHour)} (${formatNPR(peakHour.peakSalesInPaisa)})
Busiest specific day-and-hour combinations by order count: ${topDayHourCombos.length > 0 ? topDayHourCombos.join("; ") : "(no completed orders in range)"}
Order completion rate (paid, non-cancelled orders): ${completion.completionRatePercent}%
Average time from order placed to completed: ${completion.avgCompletionMinutes !== null ? `${completion.avgCompletionMinutes} minutes` : "n/a (no completed orders in range)"}

Order stage durations (average time an order spends in each stage before advancing):
${stageDurationText || "(no status transitions recorded in this range)"}
Cancellation rate: ${orderPerformance.cancellationRatePercent}% (${orderPerformance.cancelledCount} orders)
Average time before cancellation: ${orderPerformance.avgMinutesBeforeCancellation !== null ? `${orderPerformance.avgMinutesBeforeCancellation} minutes` : "n/a"}
Cancellation reasons: ${cancellationReasonText || "(none recorded)"}
Average table turn time (dine-in orders, placed to completed): ${orderPerformance.avgTableTurnMinutes !== null ? `${orderPerformance.avgTableTurnMinutes} minutes` : "n/a (no dine-in orders completed in range)"}
Staff throughput (orders completed by whoever moved them to "completed"): ${staffThroughputText || "(none recorded)"}

vs. the previous period of the same length (${comparison.previousRange.from} to ${comparison.previousRange.to}):
Revenue change: ${formatChange(comparison.revenueChangePercent)}
Orders change: ${formatChange(comparison.ordersChangePercent)}
Average order value change: ${formatChange(comparison.avgOrderValueChangePercent)}
Net profit change: ${formatChange(comparison.netProfitChangePercent)}
${branchText ? `\nRevenue by branch:\n${branchText}\n` : ""}=== END DATA ===

Answer concisely (a few sentences, or a short list when comparing multiple items) and always express money using the "Rs." format shown above. Be direct and factual — this is a working business owner checking their own numbers, not a general chat conversation.`;
}

export type AssistantUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type AssistantAnswer = {
  answer: string;
  stopReason: string | null;
  /** Phase 7 — token counts as reported by the provider, for the AI usage ledger (src/lib/ai/usage-db.ts). Null fields when the provider's response didn't include usage data. */
  usage: AssistantUsage;
};

export class AssistantApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "AssistantApiError";
  }
}

/**
 * Calls whichever provider `config` names (Groq by default — see
 * config.ts's AI_PROVIDER doc comment; Anthropic remains fully supported).
 * Takes an injectable fetchImpl (default global fetch) so the request/
 * response handling can be unit tested without live network or a real API
 * key.
 *
 * The two providers' request/response shapes genuinely differ (Groq's
 * OpenAI-compatible chat-completions API puts the system prompt inside
 * `messages[]` and returns text at `choices[0].message.content`; Anthropic's
 * Messages API takes a top-level `system` field and returns a `content[]`
 * block array) — branching here, once, is simpler and less error-prone than
 * a fake shared shape that hides the difference.
 */
export async function askAssistant(
  params: { systemPrompt: string; question: string },
  config: AiConfig = getAiConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<AssistantAnswer> {
  if (config.provider === "groq") {
    return askGroq(params, config, fetchImpl);
  }
  return askAnthropic(params, config, fetchImpl);
}

export type AssistantFailoverAttempt = {
  provider: string;
  model: string;
  error: unknown;
};

export type AssistantFailoverResult = AssistantAnswer & {
  provider: string;
  model: string;
  /** Every provider tried before the one that finally succeeded — empty when the first provider in the chain succeeded. Lets the caller log a failure per attempted provider even though only the final success is returned. */
  failedAttempts: AssistantFailoverAttempt[];
};

export class AssistantAllProvidersFailedError extends Error {
  constructor(public readonly attempts: AssistantFailoverAttempt[]) {
    super(`Every configured AI provider failed (${attempts.length} attempted).`);
    this.name = "AssistantAllProvidersFailedError";
  }
}

/**
 * Platform Control Center (Phase 7) — tries each config in `chain`, in
 * order, returning the first success. Pure orchestration over askAssistant
 * (no DB, no env reads of its own) — the caller resolves the actual chain
 * (src/lib/ai/provider-config-db.ts's resolveAiProviderChain()) and is
 * responsible for persisting each attempt to the usage ledger; this
 * function only reports what happened via the return value/thrown error so
 * the caller can log every attempt without this module needing to know
 * anything about ai_usage_logs.
 *
 * Throws AssistantAllProvidersFailedError (carrying every attempt) only if
 * EVERY provider in the chain fails — a single provider's outage is
 * invisible to the end user as long as at least one other configured
 * provider succeeds.
 */
export async function askAssistantWithFailover(
  params: { systemPrompt: string; question: string },
  chain: AiConfig[],
  fetchImpl: typeof fetch = fetch,
): Promise<AssistantFailoverResult> {
  const failedAttempts: AssistantFailoverAttempt[] = [];
  for (const config of chain) {
    try {
      const result = await askAssistant(params, config, fetchImpl);
      return { ...result, provider: config.provider, model: config.model, failedAttempts };
    } catch (error) {
      failedAttempts.push({ provider: config.provider, model: config.model, error });
    }
  }
  throw new AssistantAllProvidersFailedError(failedAttempts);
}

async function askAnthropic(
  params: { systemPrompt: string; question: string },
  config: AnthropicConfig,
  fetchImpl: typeof fetch,
): Promise<AssistantAnswer> {
  const res = await fetchImpl(config.apiUrl, {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": config.apiVersion,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 512,
      system: params.systemPrompt,
      messages: [{ role: "user", content: params.question }],
    }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !Array.isArray(body.content)) {
    throw new AssistantApiError("Anthropic API request failed.", res.status, body);
  }

  const textBlock = body.content.find(
    (block: unknown): block is { type: string; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
  );
  if (!textBlock || typeof textBlock.text !== "string") {
    throw new AssistantApiError("Anthropic API response had no text content.", res.status, body);
  }

  const inputTokens = typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : null;
  const outputTokens = typeof body.usage?.output_tokens === "number" ? body.usage.output_tokens : null;

  return {
    answer: textBlock.text,
    stopReason: body.stop_reason ?? null,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    },
  };
}

async function askGroq(
  params: { systemPrompt: string; question: string },
  config: GroqConfig,
  fetchImpl: typeof fetch,
): Promise<AssistantAnswer> {
  const res = await fetchImpl(config.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 512,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.question },
      ],
    }),
  });

  const body = await res.json().catch(() => null);
  const message = body?.choices?.[0]?.message;
  if (!res.ok || !body || !message || typeof message.content !== "string") {
    throw new AssistantApiError("Groq API request failed.", res.status, body);
  }

  const promptTokens = typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : null;
  const completionTokens = typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : null;
  const totalTokens = typeof body.usage?.total_tokens === "number" ? body.usage.total_tokens : null;

  return {
    answer: message.content,
    stopReason: body.choices[0].finish_reason ?? null,
    usage: { promptTokens, completionTokens, totalTokens },
  };
}
