"use client";

import { useState } from "react";

/**
 * Phase 15 — a menu item's photo, used everywhere an item appears as a card
 * (menu management, POS, the public QR order menu). Falls back to a colored
 * initial-letter tile when there's no image, or when the stored URL fails
 * to load (a since-deleted external image host, a corrupt data: URL, etc.)
 * — never a broken-image icon.
 *
 * Plain <img>, not next/image: item photos are either arbitrary external
 * URLs (no domain to whitelist ahead of time) or data: URLs (nothing for
 * the image optimizer to fetch/transform in the first place), so
 * next/image's optimizer doesn't apply here — same reasoning as the
 * existing QR-code <img> in TablesManager.tsx.
 */
export function MenuItemThumb({
  imageUrl,
  name,
  size = "md",
  rounded = "rounded-lg",
  className = "",
}: {
  imageUrl: string | null | undefined;
  name: string;
  // "sm"/"md"/"lg" are fixed pixel sizes (row thumbnails, form previews).
  // "fill" stretches to 100% of the parent — only correct when the parent
  // itself is size-constrained (e.g. an `aspect-square`/`aspect-[16/9]`
  // wrapper), like the POS item-grid card and the public menu's item hero
  // image. Mixing "fill" with a fixed-size parent (or a fixed size with a
  // `className` size override) is what caused the Phase 15 public-menu
  // row-thumbnail layout bug — Tailwind's utility precedence isn't
  // className-order-based, so `h-full` silently won over `h-20`.
  size?: "sm" | "md" | "lg" | "fill";
  rounded?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  const sizeClasses =
    size === "sm"
      ? "h-10 w-10 text-sm"
      : size === "lg"
        ? "h-20 w-20 text-2xl"
        : size === "fill"
          ? "h-full w-full text-3xl"
          : "h-16 w-16 text-lg";

  if (!imageUrl || failed) {
    const initial = name.trim().charAt(0).toUpperCase() || "?";
    return (
      <div
        className={`flex shrink-0 items-center justify-center bg-orange-500/15 font-semibold text-orange-300 ${rounded} ${sizeClasses} ${className}`}
        aria-hidden="true"
      >
        {initial}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary external URLs / data: URLs, not eligible for next/image's optimizer
    <img
      src={imageUrl}
      alt={name}
      onError={() => setFailed(true)}
      className={`shrink-0 object-cover ${rounded} ${sizeClasses} ${className}`}
    />
  );
}
