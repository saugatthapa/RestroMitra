import { describe, it, expect } from "vitest";
import {
  wrapText,
  EscPosBuilder,
  buildKotTicketEscPos,
  buildBillEscPos,
  type EscPosKotTicket,
  type EscPosBill,
} from "./escpos";

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

describe("wrapText", () => {
  it("keeps a short line intact", () => {
    expect(wrapText("Chicken Momo", 32)).toEqual(["Chicken Momo"]);
  });

  it("wraps long text at word boundaries without exceeding the width", () => {
    const lines = wrapText("A very long menu item name that does not fit on one line", 20);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
    expect(lines.join(" ")).toContain("A very long menu");
  });

  it("hard-breaks a single word longer than the width", () => {
    const lines = wrapText("Supercalifragilisticexpialidocious", 10);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
    expect(lines.join("")).toBe("Supercalifragilisticexpialidocious");
  });

  it("returns a single empty line for empty input", () => {
    expect(wrapText("", 32)).toEqual([""]);
  });
});

describe("EscPosBuilder", () => {
  it("prefixes output with the ESC @ initialize command", () => {
    const bytes = new EscPosBuilder().build();
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
  });

  it("line() emits the text followed by a line feed", () => {
    const bytes = new EscPosBuilder().line("hello").build();
    const text = decode(bytes);
    expect(text).toContain("hello");
    // ESC @ (2 bytes) + "hello" (5 bytes) + LF (1 byte)
    expect(bytes).toHaveLength(2 + 5 + 1);
  });

  it("bold() toggles ESC E 1 / ESC E 0 around text", () => {
    const bytes = new EscPosBuilder().bold(true).line("x").bold(false).build();
    const arr = Array.from(bytes);
    expect(arr).toEqual(
      expect.arrayContaining([0x1b, 0x45, 1, "x".charCodeAt(0), 0x0a, 0x1b, 0x45, 0]),
    );
  });

  it("cut() ends with the GS V 1 partial-cut command", () => {
    const bytes = new EscPosBuilder().cut().build();
    expect(Array.from(bytes.slice(-3))).toEqual([0x1d, 0x56, 0x01]);
  });

  it("line() strips embedded ESC/GS control bytes instead of passing them through raw", () => {
    // RC audit P0 regression test: a malicious/careless customer note
    // containing a literal ESC (0x1B) + GS V (0x1D 0x56) "cut" sequence
    // must not reach the printer's own command stream unescaped.
    const injected = "Note\x1b\x40\x1dV\x00 no onions";
    const bytes = new EscPosBuilder().line(injected).build();
    const arr = Array.from(bytes);
    // Only the builder's own leading ESC @ (indices 0-1) may contain 0x1b —
    // none of the injected control bytes may appear anywhere after it.
    const afterHeader = arr.slice(2);
    expect(afterHeader).not.toContain(0x1b);
    expect(afterHeader).not.toContain(0x1d);
  });

  it("line() replaces control bytes with spaces rather than silently dropping content", () => {
    const bytes = new EscPosBuilder().line("a\x07b").build();
    const text = decode(bytes);
    expect(text).toContain("a b");
  });

  it("line() leaves ordinary printable text, including the LF it appends itself, untouched", () => {
    const bytes = new EscPosBuilder().line("hello").build();
    const text = decode(bytes);
    expect(text).toContain("hello");
    expect(bytes).toHaveLength(2 + 5 + 1);
  });

  // Every builder starts with the 2-byte ESC @ initialize header (see the
  // "prefixes output" test above) — 0x1b/0x40 both happen to decode as
  // valid single-byte UTF-8 characters rather than a line break, so they'd
  // land inside the first decoded "line" and throw off exact-length
  // assertions below. Strip them before decoding, same idea as the
  // existing line()-length tests accounting for that header explicitly.
  function decodeBody(bytes: Uint8Array): string {
    return decode(bytes.slice(2));
  }

  describe("row()", () => {
    it("pads left and right text to fill exactly the configured width", () => {
      const bytes = new EscPosBuilder(20).row("Subtotal", "Rs. 450.00").build();
      const line = decodeBody(bytes).split("\n")[0];
      expect(line.length).toBe(20);
      expect(line.startsWith("Subtotal")).toBe(true);
      expect(line.endsWith("Rs. 450.00")).toBe(true);
    });

    it("keeps left+right combined length equal to the configured width when they fit", () => {
      const bytes = new EscPosBuilder(24).row("Total", "Rs. 1,200.00").build();
      const line = decodeBody(bytes).split("\n")[0];
      expect(line.length).toBe(24);
      expect(line.startsWith("Total")).toBe(true);
      expect(line.endsWith("Rs. 1,200.00")).toBe(true);
    });

    it("does not collapse the padding between columns the way line()'s word-wrap would", () => {
      // Regression guard: row() must NOT go through line()'s wrapText for
      // the padded string, since wrapText collapses runs of whitespace
      // when it rejoins words — that would silently misalign every column.
      const bytes = new EscPosBuilder(16).row("Tax", "Rs. 10.00").build();
      const line = decodeBody(bytes).split("\n")[0];
      expect(line).toContain("   "); // multiple spaces survive
      expect(line.length).toBe(16);
    });

    it("wraps a long left column and prints right alone, right-aligned, when the two don't fit together", () => {
      const bytes = new EscPosBuilder(16)
        .row("A very long menu item name here", "Rs. 300.00")
        .build();
      const lines = decodeBody(bytes).trim().split("\n");
      for (const line of lines.slice(0, -1)) expect(line.length).toBeLessThanOrEqual(16);
      const lastLine = lines[lines.length - 1];
      expect(lastLine.endsWith("Rs. 300.00")).toBe(true);
      expect(lastLine.length).toBe(16);
    });
  });
});

function ticket(overrides: Partial<EscPosKotTicket> = {}): EscPosKotTicket {
  return {
    headerText: "Test Restaurant",
    stationName: "Kitchen",
    kotSequence: 7,
    orderNumber: "20260819-0001",
    tableOrTakeaway: "Table 5",
    customerName: null,
    placedAt: "8/19/2026, 10:00:00 AM",
    orderNotes: null,
    items: [
      { quantity: 2, name: "Chicken Momo", variantName: null, addonNames: [], notes: null },
    ],
    ...overrides,
  };
}

describe("buildKotTicketEscPos", () => {
  it("includes the header, ticket number, order number, and item lines", () => {
    const text = decode(buildKotTicketEscPos(ticket()));
    expect(text).toContain("TEST RESTAURANT");
    expect(text).toContain("#7");
    expect(text).toContain("Kitchen");
    expect(text).toContain("Order #20260819-0001");
    expect(text).toContain("Table 5");
    expect(text).toContain("2 x Chicken Momo");
  });

  it("includes variant, addons, and item notes when present", () => {
    const text = decode(
      buildKotTicketEscPos(
        ticket({
          items: [
            {
              quantity: 1,
              name: "Momo",
              variantName: "Spicy",
              addonNames: ["Extra chutney", "Cheese"],
              notes: "No onions",
            },
          ],
        }),
      ),
    );
    expect(text).toContain("1 x Momo (Spicy)");
    expect(text).toContain("Extra chutney, Cheese");
    expect(text).toContain("No onions");
  });

  it("includes order-level notes only when set", () => {
    const withNotes = decode(buildKotTicketEscPos(ticket({ orderNotes: "Birthday — add candle" })));
    expect(withNotes).toContain("Order notes: Birthday");

    const withoutNotes = decode(buildKotTicketEscPos(ticket({ orderNotes: null })));
    expect(withoutNotes).not.toContain("Order notes:");
  });

  it("shows the customer name alongside the table when present", () => {
    const text = decode(buildKotTicketEscPos(ticket({ customerName: "Test Guest" })));
    expect(text).toContain("Table 5 - Test Guest");
  });

  it("falls back to a dash when there's no KOT sequence yet", () => {
    const text = decode(buildKotTicketEscPos(ticket({ kotSequence: null })));
    expect(text).toContain("#-");
  });

  it("ends with a cut command", () => {
    const bytes = buildKotTicketEscPos(ticket());
    expect(Array.from(bytes.slice(-3))).toEqual([0x1d, 0x56, 0x01]);
  });

  it("sanitizes control bytes injected via a customer-supplied item note end-to-end", () => {
    // A guest's order-item note reaches this builder as untrusted text from
    // the public QR ordering page — this proves the whole ticket-assembly
    // path, not just line() in isolation, never lets one through raw.
    const bytes = buildKotTicketEscPos(
      ticket({
        items: [
          {
            quantity: 1,
            name: "Momo",
            variantName: null,
            addonNames: [],
            notes: "spicy\x1b\x40\x1dV\x00please",
          },
        ],
      }),
    );
    // The ticket legitimately contains other ESC/GS bytes of its own
    // (bold/align/emphasizedSize toggles around other lines), so this
    // checks for the exact injected subsequence rather than banning every
    // ESC/GS byte anywhere in the output.
    const injectedSequence = [0x1b, 0x40, 0x1d, "V".charCodeAt(0), 0x00];
    const arr = Array.from(bytes);
    let found = false;
    for (let i = 0; i <= arr.length - injectedSequence.length; i++) {
      if (injectedSequence.every((b, j) => arr[i + j] === b)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(false);
    expect(decode(bytes)).toContain("please");
  });
});

function bill(overrides: Partial<EscPosBill> = {}): EscPosBill {
  return {
    restaurantName: "Test Restaurant",
    infoLines: ["Itahari-5, Sunsari", "Tel: 9800000000"],
    panNumber: "123456789",
    vatNumber: null,
    orderNumber: "20260819-0001",
    fiscalInvoiceNumber: 42,
    tableOrTakeaway: "Table 5",
    customerName: null,
    placedAt: "8/19/2026, 10:00:00 AM",
    items: [{ quantity: 2, name: "Chicken Momo", variantName: null, lineTotal: "Rs. 300.00" }],
    subtotal: "Rs. 300.00",
    discount: null,
    serviceCharge: null,
    tax: "Rs. 39.00",
    total: "Rs. 339.00",
    paid: "Rs. 339.00",
    tip: null,
    remainingDue: "Rs. 0.00",
    ...overrides,
  };
}

describe("buildBillEscPos", () => {
  it("includes the restaurant header, info lines, order/invoice numbers, items, and totals", () => {
    const text = decode(buildBillEscPos(bill()));
    expect(text).toContain("TEST RESTAURANT");
    expect(text).toContain("Itahari-5, Sunsari");
    expect(text).toContain("Tel: 9800000000");
    expect(text).toContain("PAN: 123456789");
    expect(text).toContain("Order #20260819-0001");
    expect(text).toContain("Fiscal Invoice #42");
    expect(text).toContain("Table 5");
    expect(text).toContain("2 x Chicken Momo");
    expect(text).toContain("Rs. 300.00");
    expect(text).toContain("Subtotal");
    expect(text).toContain("Total");
    expect(text).toContain("Rs. 339.00");
    expect(text).toContain("Remaining due");
  });

  it("omits the fiscal invoice number until one is assigned", () => {
    const text = decode(buildBillEscPos(bill({ fiscalInvoiceNumber: null })));
    expect(text).not.toContain("Fiscal Invoice #");
  });

  it("shows PAN and VAT together, and neither when both are unset", () => {
    const both = decode(buildBillEscPos(bill({ panNumber: "111", vatNumber: "222" })));
    expect(both).toContain("PAN: 111");
    expect(both).toContain("VAT: 222");

    const neither = decode(buildBillEscPos(bill({ panNumber: null, vatNumber: null })));
    expect(neither).not.toContain("PAN:");
    expect(neither).not.toContain("VAT:");
  });

  it("includes discount, service charge, and tip lines only when present", () => {
    const withExtras = decode(
      buildBillEscPos(
        bill({
          discount: { label: "Discount (10.00%)", amount: "Rs. 30.00" },
          serviceCharge: { label: "Service charge (5.00%)", amount: "Rs. 15.00" },
          tip: "Rs. 20.00",
        }),
      ),
    );
    expect(withExtras).toContain("Discount (10.00%)");
    expect(withExtras).toContain("-Rs. 30.00");
    expect(withExtras).toContain("Service charge (5.00%)");
    expect(withExtras).toContain("Tip (not part of bill)");

    const withoutExtras = decode(buildBillEscPos(bill()));
    expect(withoutExtras).not.toContain("Discount");
    expect(withoutExtras).not.toContain("Service charge");
    expect(withoutExtras).not.toContain("Tip");
  });

  it("shows the customer name alongside the table when present", () => {
    const text = decode(buildBillEscPos(bill({ customerName: "Test Guest" })));
    expect(text).toContain("Table 5 - Test Guest");
  });

  it("ends with a cut command", () => {
    const bytes = buildBillEscPos(bill());
    expect(Array.from(bytes.slice(-3))).toEqual([0x1d, 0x56, 0x01]);
  });

  it("sanitizes control bytes injected via a discount reason end-to-end", () => {
    const bytes = buildBillEscPos(
      bill({ discount: { label: "Discount - spicy\x1b\x40\x1dV\x00please", amount: "Rs. 10.00" } }),
    );
    const injectedSequence = [0x1b, 0x40, 0x1d, "V".charCodeAt(0), 0x00];
    const arr = Array.from(bytes);
    let found = false;
    for (let i = 0; i <= arr.length - injectedSequence.length; i++) {
      if (injectedSequence.every((b, j) => arr[i + j] === b)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(false);
    expect(decode(bytes)).toContain("please");
  });
});
