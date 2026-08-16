"use client";

/**
 * Phase 15 — turns a picked image file into a small, flattened data: URL,
 * entirely client-side (no upload endpoint, no object-storage credentials
 * needed — see PHASE_15_NOTES.md for why: this app has neither an existing
 * upload route nor cloud-storage config, and inventing either as a side
 * effect of "show item photos" would be new infrastructure the audit never
 * called for). The `menuItems.imageUrl` column is a plain `text` field, so a
 * compact data URL fits it exactly the same way an http(s) URL would.
 *
 * Resizing through a <canvas> before encoding does double duty: it keeps the
 * stored string small (a multi-megapixel phone photo would otherwise bloat
 * every menu-item row and every API response that includes one), and it
 * re-encodes the image as flat pixel data — any file structure/metadata in
 * the original upload (EXIF, embedded scripts in a mislabeled SVG, etc.)
 * never survives the round trip through canvas.
 */

const MAX_DIMENSION = 640;
const JPEG_QUALITY = 0.82;

export class ClientImageError extends Error {}

export function fileToCompressedDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    return Promise.reject(new ClientImageError("Please choose an image file."));
  }
  // A generous pre-decode guard — canvas re-encoding below is what actually
  // bounds the stored size, but rejecting an absurdly large upload before
  // spending the time/memory to decode it is a cheap first check.
  if (file.size > 20 * 1024 * 1024) {
    return Promise.reject(new ClientImageError("Image is too large (max 20MB)."));
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        const { width, height } = img;
        const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
        const targetWidth = Math.max(1, Math.round(width * scale));
        const targetHeight = Math.max(1, Math.round(height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new ClientImageError("Could not process this image in your browser."));
          return;
        }
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        // JPEG (lossy, no alpha) keeps the encoded size small and is fine
        // for food photography; PNG's per-pixel-lossless cost isn't worth
        // it here and would frequently blow past the validation cap.
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      } catch {
        reject(new ClientImageError("Could not process this image in your browser."));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new ClientImageError("Could not read this image file."));
    };
    img.src = objectUrl;
  });
}
