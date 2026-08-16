import { z } from "zod";

/**
 * Shared by any field that accepts either a real http(s) image URL or a
 * client-compressed data: URL (see src/lib/client-image.ts — the same
 * canvas-based resize/re-encode path used for menu item photos and
 * restaurant logos). Extracted out of menu.ts's original inline
 * `menuItemImageUrl` so onboarding's logoUrl field can accept the exact
 * same shapes without menu.ts's own validator (and its existing tests)
 * having to change.
 */
export function imageUrlSchema(maxBytes = 2_000_000) {
  return z
    .string()
    .trim()
    .max(maxBytes, "Image is too large.")
    .refine(
      (value) =>
        value === "" ||
        /^https?:\/\//i.test(value) ||
        /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value),
      "Image must be an http(s) URL or an uploaded image.",
    );
}
