import "server-only";
import { randomBytes } from "crypto";
import QRCode from "qrcode";

/**
 * Generates a high-entropy, URL-safe token for a table's QR code. This is
 * the ONLY identifier the public /order/[token] page accepts — it must
 * never be sequential or derivable from a table id/restaurant id, or a
 * customer could guess another table's link and place orders under it.
 * 32 bytes of randomness, base64url-encoded (~43 chars, no padding).
 */
export function generateQrToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Builds the public ordering URL a table's QR code should encode. */
export function buildOrderUrl(appUrl: string, qrToken: string): string {
  return `${appUrl.replace(/\/$/, "")}/order/${qrToken}`;
}

/**
 * Renders a QR code for the given URL as a PNG data buffer.
 *
 * Error correction is "H" (the highest level, tolerating ~30% of the code
 * being obscured) rather than the default "M" — the branded poster (see
 * QrPoster.tsx) draws the RestroMitra mark over the center of this same
 * image, and "H" is what keeps that overlay scannable instead of quietly
 * breaking codes on the printed table tents this is meant to end up on.
 */
export async function renderQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: "H",
    margin: 2,
    width: 512,
  });
}

/**
 * Commercial Launch Phase B.4 — renders a QR code as an inline `data:`
 * URL rather than a PNG buffer, for content that's embedded directly in a
 * JSON API response and drawn straight into a React component (MFA
 * enrollment's otpauth:// URI) instead of served as its own downloadable
 * image file the way table/website QR codes are. Same `qrcode` library
 * and error-correction choice as renderQrPng above — no second QR
 * dependency for this.
 */
export async function renderQrDataUrl(data: string): Promise<string> {
  return QRCode.toDataURL(data, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
  });
}
