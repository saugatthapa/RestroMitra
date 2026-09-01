import { describe, it, expect } from "vitest";
import { buildAuditLogParams } from "./audit-log-query";

describe("buildAuditLogParams", () => {
  it("always includes limit/offset even with no filters set", () => {
    const params = buildAuditLogParams({}, { limit: 50, offset: 0 });
    expect(params.toString()).toBe("limit=50&offset=0");
  });

  it("includes every filter that's set", () => {
    const params = buildAuditLogParams(
      {
        action: "payment",
        resourceType: "order",
        userId: "user-1",
        branchId: "branch-1",
        from: "2026-08-01",
        to: "2026-08-31",
      },
      { limit: 50, offset: 100 },
    );
    expect(params.get("limit")).toBe("50");
    expect(params.get("offset")).toBe("100");
    expect(params.get("action")).toBe("payment");
    expect(params.get("resourceType")).toBe("order");
    expect(params.get("userId")).toBe("user-1");
    expect(params.get("branchId")).toBe("branch-1");
    expect(params.get("from")).toBe("2026-08-01");
    expect(params.get("to")).toBe("2026-08-31");
  });

  it("trims the free-text action filter", () => {
    const params = buildAuditLogParams({ action: "  refund  " }, { limit: 50, offset: 0 });
    expect(params.get("action")).toBe("refund");
  });

  it("omits an action filter that's only whitespace", () => {
    const params = buildAuditLogParams({ action: "   " }, { limit: 50, offset: 0 });
    expect(params.has("action")).toBe(false);
  });

  it("omits empty-string filters rather than sending them", () => {
    const params = buildAuditLogParams(
      { resourceType: "", userId: "", branchId: "", from: "", to: "" },
      { limit: 50, offset: 0 },
    );
    expect(params.has("resourceType")).toBe(false);
    expect(params.has("userId")).toBe(false);
    expect(params.has("branchId")).toBe(false);
    expect(params.has("from")).toBe(false);
    expect(params.has("to")).toBe(false);
  });

  it("supports setting only a subset of filters", () => {
    const params = buildAuditLogParams({ resourceType: "table" }, { limit: 50, offset: 0 });
    expect(params.toString()).toBe("limit=50&offset=0&resourceType=table");
  });
});
