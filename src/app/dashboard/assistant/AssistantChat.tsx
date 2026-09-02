"use client";

import { useState } from "react";
import { apiPost, ApiError } from "@/lib/api-client";

type Turn = {
  question: string;
  answer: string | null;
  error: string | null;
};

const EXAMPLE_PROMPTS = [
  "How were sales over the last 30 days?",
  "What's my best-selling item?",
  "How do cash and mobile wallet payments compare?",
  "What's my biggest expense category?",
];

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

export function AssistantChat({ slug }: { slug: string }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || asking) return;
    setAsking(true);
    setQuestion("");
    const turnIndex = turns.length;
    setTurns((prev) => [...prev, { question: trimmed, answer: null, error: null }]);
    try {
      const res = await apiPost<{ answer: string }>(`${base(slug)}/assistant/ask`, {
        question: trimmed,
      });
      setTurns((prev) =>
        prev.map((t, i) => (i === turnIndex ? { ...t, answer: res.answer } : t)),
      );
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not reach the assistant.";
      setTurns((prev) => (prev.map((t, i) => (i === turnIndex ? { ...t, error: message } : t))));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="min-h-[240px] rounded-2xl border border-hairline bg-surface-2 p-5">
        {turns.length === 0 ? (
          <div>
            <p className="mb-3 text-sm text-ink-muted">
              Try one of these, or ask your own question below:
            </p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => ask(prompt)}
                  disabled={asking}
                  className="rounded-full border border-hairline-strong px-3 py-1.5 text-xs text-ink-secondary hover:border-orange-500/40 hover:text-orange-300 disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {turns.map((turn, i) => (
              <div key={i}>
                <p className="mb-1.5 text-sm font-semibold text-ink">{turn.question}</p>
                {turn.error ? (
                  <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{turn.error}</p>
                ) : turn.answer ? (
                  <p className="whitespace-pre-wrap text-sm text-ink-secondary">{turn.answer}</p>
                ) : (
                  <p className="text-sm text-ink-faint">Thinking…</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="mt-4 flex gap-2"
      >
        <input
          className="input flex-1"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about your sales, top items, or expenses…"
          disabled={asking}
          maxLength={500}
        />
        <button type="submit" disabled={asking || !question.trim()} className="btn-primary">
          {asking ? "Asking…" : "Ask"}
        </button>
      </form>
      <p className="mt-2 text-xs text-ink-faint">
        Answers are based only on this restaurant&rsquo;s data from the last 30 days — the same
        numbers shown on the Reports page.
      </p>
    </div>
  );
}
