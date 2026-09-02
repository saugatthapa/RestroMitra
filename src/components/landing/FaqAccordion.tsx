"use client";

import { useState } from "react";

export type FaqItem = { question: string; answer: string };

export function FaqAccordion({ items }: { items: FaqItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="divide-y divide-hairline rounded-2xl border border-hairline bg-surface-2">
      {items.map((item, i) => {
        const open = openIndex === i;
        return (
          <div key={item.question}>
            <button
              type="button"
              onClick={() => setOpenIndex(open ? null : i)}
              aria-expanded={open}
              className="group flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-1"
            >
              <span className="text-sm font-medium text-ink transition-colors group-hover:text-orange-300 sm:text-base">
                {item.question}
              </span>
              <span
                className={`flex h-6 w-6 flex-none items-center justify-center rounded-full border border-hairline-strong text-ink-muted transition-all duration-300 group-hover:border-orange-500/40 group-hover:text-orange-400 ${
                  open ? "rotate-45 border-orange-500/40 text-orange-400" : "group-hover:scale-110"
                }`}
                aria-hidden="true"
              >
                <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3">
                  <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </span>
            </button>
            <div
              className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out"
              style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
            >
              <div className="min-h-0">
                <p className="px-5 pb-4 text-sm leading-relaxed text-ink-secondary">{item.answer}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
