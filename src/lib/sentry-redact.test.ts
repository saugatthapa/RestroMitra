import { describe, it, expect } from "vitest";
import { redactSensitiveData, redactUrl, redactEvent } from "./sentry-redact";

describe("redactSensitiveData", () => {
  it("redacts known sensitive keys at any nesting depth", () => {
    const input = {
      customerName: "Real Name",
      order: { customerPhone: "9812345678", notes: "extra spicy" },
    };
    expect(redactSensitiveData(input)).toEqual({
      customerName: "[Redacted]",
      order: { customerPhone: "[Redacted]", notes: "extra spicy" },
    });
  });

  it("is case-insensitive on key names", () => {
    expect(redactSensitiveData({ PasswordHash: "x", Phone: "y" })).toEqual({
      PasswordHash: "[Redacted]",
      Phone: "[Redacted]",
    });
  });

  it("redacts inside arrays", () => {
    expect(redactSensitiveData([{ email: "a@b.com" }, { email: "c@d.com" }])).toEqual([
      { email: "[Redacted]" },
      { email: "[Redacted]" },
    ]);
  });

  it("leaves non-sensitive data untouched", () => {
    const input = { orderNumber: "20260823-ABCD", totalInPaisa: 25000, status: "pending" };
    expect(redactSensitiveData(input)).toEqual(input);
  });

  it("redacts password/token/session fields", () => {
    expect(
      redactSensitiveData({
        password: "hunter2",
        token: "abc",
        sessionId: "xyz",
        clientRequestId: "req-1",
      }),
    ).toEqual({
      password: "[Redacted]",
      token: "[Redacted]",
      sessionId: "[Redacted]",
      clientRequestId: "[Redacted]",
    });
  });
});

describe("redactUrl", () => {
  it("redacts the QR order token from /order/[token] URLs", () => {
    expect(redactUrl("https://app.example.com/order/abc123DEF456xyz")).toBe(
      "https://app.example.com/order/[Redacted]",
    );
  });

  it("redacts the token from the matching API route", () => {
    expect(redactUrl("/api/order/abc123DEF456xyz/service-call")).toBe(
      "/api/order/[Redacted]/service-call",
    );
  });

  it("leaves unrelated URLs untouched", () => {
    const url = "/dashboard/orders/11111111-2222-3333-4444-555555555555";
    expect(redactUrl(url)).toBe(url);
  });

  it("does not touch short path segments (below the token-length threshold)", () => {
    const url = "/order/abc";
    expect(redactUrl(url)).toBe(url);
  });
});

describe("redactEvent", () => {
  it("strips cookies and sensitive headers from event.request", () => {
    const event = {
      request: {
        url: "/api/auth/login",
        cookies: { session: "secret-session-value" },
        headers: { Cookie: "session=secret", "x-restromitra-client": "web", "Content-Type": "application/json" },
        data: { phone: "9812345678", password: "hunter2" },
      },
    };
    const result = redactEvent(event);
    expect(result.request.cookies).toBeUndefined();
    expect(result.request.headers.Cookie).toBeUndefined();
    expect(result.request.headers["x-restromitra-client"]).toBe("web");
    expect(result.request.data).toEqual({ phone: "[Redacted]", password: "[Redacted]" });
  });

  it("redacts the QR token out of event.request.url", () => {
    const event = { request: { url: "/order/abc123DEF456xyz" } };
    expect(redactEvent(event).request.url).toBe("/order/[Redacted]");
  });

  it("redacts breadcrumb data and messages", () => {
    const event = {
      breadcrumbs: [
        { category: "fetch", message: "GET /order/abc123DEF456xyz", data: { customerPhone: "9812345678" } },
        { category: "ui.click", message: "clicked Place order" },
      ],
    };
    const result = redactEvent(event);
    expect(result.breadcrumbs[0].message).toBe("GET /order/[Redacted]");
    expect(result.breadcrumbs[0].data).toEqual({ customerPhone: "[Redacted]" });
    expect(result.breadcrumbs[1].message).toBe("clicked Place order");
  });

  it("does not mutate the input event", () => {
    const event = { request: { cookies: { session: "x" } } };
    redactEvent(event);
    expect(event.request.cookies).toEqual({ session: "x" });
  });

  it("passes through an event with no request/breadcrumbs unchanged", () => {
    const event = { message: "Something broke", level: "error" };
    expect(redactEvent(event)).toEqual(event);
  });
});
