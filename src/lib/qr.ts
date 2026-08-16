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

/** Renders a QR code for the given URL as a PNG data buffer. */
export async function renderQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
  });
}
