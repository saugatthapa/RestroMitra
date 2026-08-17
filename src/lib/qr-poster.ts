// Client-only. Renders a branded, printable "table tent" style poster
// around an already-generated QR code PNG (see src/lib/qr.ts) and triggers
// a browser download — entirely in a <canvas>, no server round trip and no
// new server-side image dependency (a native `canvas` package is a common
// source of broken production builds, so this deliberately stays in the
// browser where Image/canvas are always available).
//
// This exists because a bare QR code — square, black-and-white, no
// branding — isn't something an owner can put in front of a customer and
// expect them to trust or even understand. The poster adds the restaurant's
// own identity front and center (name, optional table label), a plain-
// language call to action, and a small "Powered by RestroMitra" credit at
// the very bottom — same customer-facing hierarchy as the public site and
// QR-menu footers (src/app/site/[slug]/page.tsx, PublicOrderMenu.tsx): the
// restaurant leads, the platform is the quiet small print.

const MARK_SRC = "/brand/icon-256.png";

export type QrPosterOptions = {
  /** URL that returns the raw QR PNG (e.g. the table's /qr API route). */
  qrImageUrl: string;
  /** The restaurant's own name — always shown, largest text on the poster. */
  restaurantName: string;
  /** Optional secondary line under the name, e.g. a table name. */
  subtitle?: string;
  /** Call-to-action pill text under the QR code. */
  ctaLabel?: string;
  /** Filename for the downloaded PNG. */
  fileName: string;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${src}`));
    img.src = src;
  });
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws `text` centered at (cx, y), wrapping onto extra lines if it would
 * exceed `maxWidth`, and returns the y position just below the last line. */
function drawWrappedCenteredText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  // Never more than 2 lines on a poster — anything longer would crowd the
  // QR code out, so a very long name just truncates on the second line.
  const shown = lines.slice(0, 2);
  if (lines.length > 2) {
    const last = shown[1];
    shown[1] = `${last.replace(/\s+\S*$/, "")}…`;
  }
  shown.forEach((line, i) => {
    ctx.fillText(line, cx, y + i * lineHeight);
  });
  return y + (shown.length - 1) * lineHeight;
}

export async function downloadQrPoster(opts: QrPosterOptions): Promise<void> {
  const [qrImg, markImg] = await Promise.all([
    loadImage(opts.qrImageUrl),
    loadImage(MARK_SRC),
  ]);

  const W = 1200;
  const H = 1680;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser doesn't support canvas image export.");

  // Background
  ctx.fillStyle = "#FBF8F3";
  ctx.fillRect(0, 0, W, H);

  // Outer frame
  const inset = 30;
  ctx.strokeStyle = "#F0DFC8";
  ctx.lineWidth = 3;
  roundedRectPath(ctx, inset, inset, W - inset * 2, H - inset * 2, 40);
  ctx.stroke();

  // Eyebrow
  ctx.textAlign = "center";
  ctx.fillStyle = "#EA580C";
  ctx.font = "700 26px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillText("SCAN TO ORDER", W / 2, 140);

  // Restaurant name (wraps up to 2 lines)
  ctx.fillStyle = "#171717";
  ctx.font = "800 62px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const nameBottom = drawWrappedCenteredText(ctx, opts.restaurantName, W / 2, 225, W - 200, 72);

  // Optional subtitle (e.g. table name)
  let afterHeader = nameBottom + 60;
  if (opts.subtitle) {
    ctx.fillStyle = "#8A8A8A";
    ctx.font = "600 30px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillText(opts.subtitle, W / 2, afterHeader);
    afterHeader += 20;
  }

  // QR card
  const qrCardSize = 640;
  const qrCardX = (W - qrCardSize) / 2;
  const qrCardY = Math.max(afterHeader + 30, 380);
  ctx.save();
  ctx.shadowColor = "rgba(20, 20, 20, 0.12)";
  ctx.shadowBlur = 44;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = "#ffffff";
  roundedRectPath(ctx, qrCardX, qrCardY, qrCardSize, qrCardSize, 36);
  ctx.fill();
  ctx.restore();

  const qrPad = 50;
  const qrSize = qrCardSize - qrPad * 2;
  ctx.drawImage(qrImg, qrCardX + qrPad, qrCardY + qrPad, qrSize, qrSize);

  // Center watermark — white quiet-zone disc behind the mark so it never
  // touches (and confuses) the QR modules themselves.
  const cx = qrCardX + qrCardSize / 2;
  const cy = qrCardY + qrCardSize / 2;
  const markSize = qrSize * 0.2;
  const discRadius = markSize / 2 + 12;
  ctx.beginPath();
  ctx.arc(cx, cy, discRadius, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.drawImage(markImg, cx - markSize / 2, cy - markSize / 2, markSize, markSize);

  // CTA pill
  const ctaText = opts.ctaLabel ?? "Scan to view menu & order";
  ctx.font = "700 30px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const ctaPadX = 46;
  const ctaWidth = Math.min(ctx.measureText(ctaText).width + ctaPadX * 2, W - 160);
  const ctaHeight = 76;
  const ctaX = (W - ctaWidth) / 2;
  const ctaY = qrCardY + qrCardSize + 64;
  roundedRectPath(ctx, ctaX, ctaY, ctaWidth, ctaHeight, ctaHeight / 2);
  ctx.fillStyle = "#EA580C";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(ctaText, W / 2, ctaY + ctaHeight / 2 + 2, ctaWidth - ctaPadX);
  ctx.textBaseline = "alphabetic";

  // Footer — "Powered by RestroMitra", deliberately the smallest, quietest
  // element on the page (see file header comment).
  const footerY = H - 96;
  const footerMarkSize = 40;
  const footerLabel = "Powered by RestroMitra";
  ctx.font = "600 24px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const labelWidth = ctx.measureText(footerLabel).width;
  const totalWidth = footerMarkSize + 10 + labelWidth;
  const startX = W / 2 - totalWidth / 2;
  ctx.drawImage(markImg, startX, footerY - footerMarkSize / 2, footerMarkSize, footerMarkSize);
  ctx.fillStyle = "#737373";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(footerLabel, startX + footerMarkSize + 10, footerY + 1);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not export the poster image."))), "image/png");
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = opts.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
