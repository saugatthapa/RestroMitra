/**
 * ESC/POS command building for thermal receipt/KOT printers — Phase 23.
 *
 * Deliberately a plain, dependency-free, DOM-free module (same pattern as
 * kot-ticket.ts) so it's unit-testable without a browser and shares zero
 * knowledge of *how* the bytes reach a printer (that's web-serial-printer.ts
 * — this file only ever produces a Uint8Array).
 *
 * Reference: Epson's ESC/POS command set, which the vast majority of
 * "generic ESC/POS compatible" thermal printers (the common, inexpensive
 * kind sold for small restaurants) implement a compatible subset of. Not
 * every printer supports every command here — cutting in particular varies
 * (GS V is the modern standard used below; a handful of older/cheaper
 * models only respond to the legacy ESC i / ESC m forms) — but GS V is the
 * broadest-compatibility choice for anything sold in the last ~15 years.
 *
 * Text encoding: only ASCII (0x00-0x7F) is guaranteed to render correctly
 * across printer codepages without per-model configuration — this module
 * encodes as UTF-8 bytes, which is byte-identical to ASCII for that range,
 * so plain English/Romanized menu text prints reliably. Actual Devanagari
 * (Nepali script) text will NOT render correctly on most thermal printers
 * without a specific codepage/font table for it, which varies by printer
 * model — that's an honest limitation of ESC/POS hardware in general, not
 * something this module can paper over. Non-ASCII characters are passed
 * through as-is; what a given printer does with them is up to its firmware.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/**
 * RC audit P0 fix — strips ASCII control bytes (0x00-0x1F, plus DEL 0x7F)
 * out of any text before it's encoded, replacing each with a plain space.
 *
 * Why this matters: `line()`'s output ultimately reaches a real thermal
 * printer as raw, unescaped bytes with no separation between "bytes the
 * app meant as a command" and "bytes that happen to be sitting inside a
 * text field" — the printer's firmware treats ESC (0x1B), GS (0x1D), and
 * the rest of the control range as command bytes wherever they appear in
 * the stream. Several of the strings that flow into `line()` (order/item
 * notes, in particular) originate from the public, unauthenticated QR
 * ordering page with no character restriction today — so without this,
 * a customer could type/POST a note containing a literal control
 * character sequence (e.g. GS V — cut, or a printer-model-specific
 * cash-drawer-kick command) and have it execute on hardware physically at
 * the restaurant the next time that ticket prints. Any legitimate line
 * break the caller wants is expressed by calling `line()` again, or via
 * `wrapText`'s own wrapping — never by embedding a raw LF/CR inside the
 * text itself — so it's safe to strip all of them here, LF (0x0A)
 * included.
 */
function sanitizeForPrinter(text: string): string {
  let result = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    result += code <= 0x1f || code === 0x7f ? " " : ch;
  }
  return result;
}

type Align = "left" | "center" | "right";

const ALIGN_CODES: Record<Align, number> = { left: 0, center: 1, right: 2 };

/**
 * Word-wraps text to a fixed column width. Raw ESC/POS text has no
 * automatic line wrapping guaranteed across every printer model — a long
 * menu item name run past the physical paper width can print truncated or
 * garbled on some firmwares — so this wraps defensively before encoding.
 * `width` should match the printer's character width at the font size in
 * use (58mm paper at the default font is commonly ~32 columns, 80mm ~48;
 * see DEFAULT_CHAR_WIDTH below).
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > width) {
      // A single "word" longer than the whole line (rare — a run-on SKU or
      // similar) — hard-break it rather than let it overflow untouched.
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

export const DEFAULT_CHAR_WIDTH = 32;

/**
 * A small builder that accumulates ESC/POS bytes — mirrors the shape of
 * common ESC/POS libraries closely enough to be familiar, but hand-rolled
 * (no runtime dependency) since the command set actually needed here is
 * small and fixed.
 */
export class EscPosBuilder {
  private chunks: number[] = [];
  private charWidth: number;

  constructor(charWidth: number = DEFAULT_CHAR_WIDTH) {
    this.charWidth = charWidth;
    this.chunks.push(ESC, 0x40); // ESC @ — initialize printer
  }

  align(align: Align): this {
    this.chunks.push(ESC, 0x61, ALIGN_CODES[align]);
    return this;
  }

  bold(on: boolean): this {
    this.chunks.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }

  /** Double-height + double-width text — used for the ticket's station name. */
  emphasizedSize(on: boolean): this {
    this.chunks.push(GS, 0x21, on ? 0x11 : 0x00);
    return this;
  }

  /** One line of text, word-wrapped to the configured character width, each wrapped line ending in LF. */
  line(text: string = ""): this {
    const safe = sanitizeForPrinter(text);
    for (const wrapped of wrapText(safe, this.charWidth)) {
      this.chunks.push(...Array.from(new TextEncoder().encode(wrapped)));
      this.chunks.push(LF);
    }
    return this;
  }

  /** A full-width dashed divider, sized to the current character width. */
  divider(): this {
    return this.line("-".repeat(this.charWidth));
  }

  feed(lines: number = 1): this {
    this.chunks.push(ESC, 0x64, lines);
    return this;
  }

  /** Partial cut (GS V 1) — leaves a small connecting strip like most tear-bar thermal printers expect; a few lines of feed first so the cut lands below the printed content instead of through it. */
  cut(): this {
    this.feed(3);
    this.chunks.push(GS, 0x56, 1);
    return this;
  }

  build(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

export type EscPosKotTicket = {
  headerText: string;
  stationName: string;
  kotSequence: number | null;
  orderNumber: string;
  tableOrTakeaway: string;
  customerName: string | null;
  placedAt: string;
  items: {
    quantity: number;
    name: string;
    variantName: string | null;
    addonNames: string[];
    notes: string | null;
  }[];
  orderNotes: string | null;
};

/**
 * Builds the ESC/POS byte sequence for one station's Kitchen Order
 * Ticket — the direct-print equivalent of one <div> in KotTicketView.tsx's
 * stationTickets.map(...). Mirrors that layout's content and order exactly
 * so a "direct thermal print" and a "browser print dialog" copy of the
 * same ticket read identically, just on different paper.
 */
export function buildKotTicketEscPos(
  ticket: EscPosKotTicket,
  charWidth: number = DEFAULT_CHAR_WIDTH,
): Uint8Array {
  const b = new EscPosBuilder(charWidth);

  b.align("center").bold(true).line(ticket.headerText.toUpperCase()).bold(false);
  b.line("Kitchen Order Ticket");
  b.divider();
  b.emphasizedSize(true).line(`#${ticket.kotSequence ?? "-"}  ${ticket.stationName}`).emphasizedSize(false);
  b.divider();

  b.align("left");
  b.line(`Order #${ticket.orderNumber}`);
  const tableLine = ticket.customerName
    ? `${ticket.tableOrTakeaway} - ${ticket.customerName}`
    : ticket.tableOrTakeaway;
  b.line(tableLine);
  b.line(ticket.placedAt);
  b.divider();

  for (const item of ticket.items) {
    const variant = item.variantName ? ` (${item.variantName})` : "";
    b.bold(true).line(`${item.quantity} x ${item.name}${variant}`).bold(false);
    if (item.addonNames.length > 0) {
      b.line(`  + ${item.addonNames.join(", ")}`);
    }
    if (item.notes) {
      b.line(`  Note: ${item.notes}`);
    }
  }

  if (ticket.orderNotes) {
    b.divider();
    b.line(`Order notes: ${ticket.orderNotes}`);
  }

  b.cut();
  return b.build();
}
