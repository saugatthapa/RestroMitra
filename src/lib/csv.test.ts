import { describe, it, expect } from "vitest";
import { toCsv } from "./csv";

type Row = { name: string; amount: number; note: string | null; active: boolean };

describe("toCsv", () => {
  it("happy path: serializes a header row plus one row per record, CRLF-terminated", () => {
    const rows: Row[] = [{ name: "Sales", amount: 1250.5, note: "cash sale", active: true }];
    const csv = toCsv(rows, [
      { header: "Name", value: (r) => r.name },
      { header: "Amount", value: (r) => r.amount },
      { header: "Note", value: (r) => r.note },
      { header: "Active", value: (r) => r.active },
    ]);
    expect(csv).toBe("Name,Amount,Note,Active\r\nSales,1250.5,cash sale,true\r\n");
  });

  it("edge case: an empty row array produces just the header row", () => {
    const csv = toCsv<Row>([], [{ header: "Name", value: (r) => r.name }]);
    expect(csv).toBe("Name\r\n");
  });

  it("quotes and escapes a field containing a comma", () => {
    const rows = [{ name: "Ram, Shyam & Co" }];
    const csv = toCsv(rows, [{ header: "Name", value: (r) => r.name }]);
    expect(csv).toBe('Name\r\n"Ram, Shyam & Co"\r\n');
  });

  it("quotes and doubles an embedded double-quote", () => {
    const rows = [{ name: 'The "Best" Cafe' }];
    const csv = toCsv(rows, [{ header: "Name", value: (r) => r.name }]);
    expect(csv).toBe('Name\r\n"The ""Best"" Cafe"\r\n');
  });

  it("quotes a field containing an embedded newline", () => {
    const rows = [{ note: "line one\nline two" }];
    const csv = toCsv(rows, [{ header: "Note", value: (r) => r.note }]);
    expect(csv).toBe('Note\r\n"line one\nline two"\r\n');
  });

  it("edge case: null and undefined values serialize to an empty field, not the literal string 'null'/'undefined'", () => {
    const rows = [{ note: null as string | null }, { note: undefined as unknown as string | null }];
    const csv = toCsv(rows, [{ header: "Note", value: (r) => r.note }]);
    expect(csv).toBe("Note\r\n\r\n\r\n");
  });

  it("edge case: a value containing only a lone quote character is still quoted and escaped", () => {
    const rows = [{ note: '"' }];
    const csv = toCsv(rows, [{ header: "Note", value: (r) => r.note }]);
    expect(csv).toBe('Note\r\n""""\r\n');
  });

  it("a header containing a comma is itself quoted", () => {
    const csv = toCsv<Row>([], [{ header: "Amount, Rs", value: (r) => r.amount }]);
    expect(csv).toBe('"Amount, Rs"\r\n');
  });
});
