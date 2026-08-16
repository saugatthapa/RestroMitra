"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Scroll-triggered fade/slide-in wrapper for landing-page sections — a
 * thin IntersectionObserver hook, not a dependency. Pulling in a full
 * animation library (framer-motion et al.) for "fade in when scrolled
 * into view" would cost real First Load JS for a marketing page that
 * should load fast on a mid-range Android over Nepali mobile data; this
 * is a few hundred bytes and does exactly one job.
 *
 * Reveals once and disconnects (no re-hide on scroll-away — a landing
 * page shouldn't replay its own animations every time someone scrolls
 * up). `prefers-reduced-motion` is honored entirely in CSS (see
 * globals.css's `.reveal` rules), so this component doesn't need to know
 * about that preference itself.
 */
export function Reveal({
  children,
  className = "",
  delayMs = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delayMs?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -60px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${visible ? "reveal-visible" : ""} ${className}`}
      style={visible ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </div>
  );
}
