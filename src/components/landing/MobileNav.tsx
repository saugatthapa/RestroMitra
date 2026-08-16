"use client";

import { useState } from "react";
import Link from "next/link";

const LINKS = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#compare", label: "Compare" },
  { href: "#faq", label: "FAQ" },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Toggle menu"
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-700 transition-colors duration-200 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600"
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-4.5 w-4.5">
          {open ? (
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          ) : (
            <path
              d="M3 5h14M3 10h14M3 15h14"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          )}
        </svg>
      </button>

      {open && (
        <div className="absolute inset-x-0 top-full z-40 border-b border-neutral-200 bg-white/95 px-4 pb-4 pt-2 shadow-lg backdrop-blur">
          <nav className="flex flex-col gap-1">
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-neutral-700 transition-all duration-200 hover:translate-x-1 hover:bg-orange-50 hover:text-orange-700"
              >
                {link.label}
              </a>
            ))}
            <div className="mt-2 flex flex-col gap-2 border-t border-neutral-100 pt-3">
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="btn-secondary w-full"
              >
                Log in
              </Link>
              <Link
                href="/register"
                onClick={() => setOpen(false)}
                className="btn-primary w-full"
              >
                Start free trial
              </Link>
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
