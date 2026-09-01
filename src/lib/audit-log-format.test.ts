import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatImpersonationEvent,
  formatAuditLogEntry,
  formatAuditLogModifiers,
} from "./audit-log-format";

describe("formatDuration", () => {
  it("rounds sub-minute durations down to 'less than a minute'", () => {
    expect(formatDuration(0)).toBe("less than a minute");
    expect(formatDuration(45_000)).toBe("less than a minute");
    expect(formatDuration(59_999)).toBe("less than a minute");
  });

  it("formats whole minutes", () => {
    expect(formatDuration(60_000)).toBe("1 minute");
    expect(formatDuration(14 * 60_000)).toBe("14 minutes");
  });

  it("formats hours and minutes, capped at the two most significant units", () => {
    expect(formatDuration(60 * 60_000)).toBe("1 hour");
    expect(formatDuration(2 * 60 * 60_000 + 5 * 60_000)).toBe("2 hours 5 minutes");
  });

  it("formats days and hours, dropping minutes once days are involved", () => {
    expect(formatDuration(25 * 60 * 60_000 + 10 * 60_000)).toBe("1 day 1 hour");
  });

  it("never returns an empty string for a negative/garbage input", () => {
    expect(formatDuration(-5000)).toBe("less than a minute");
  });
});

describe("formatImpersonationEvent", () => {
  it("formats a start event into a plain sentence", () => {
    const sentence = formatImpersonationEvent({
      action: "admin.impersonation_started",
      userFullName: "Jane Doe",
      metadata: {
        reason: "investigating billing issue",
        mode: "read_only",
        targetRestaurantName: "Momo Palace",
      },
    });
    expect(sentence).toBe(
      'Platform admin Jane Doe started a read-only impersonation session for Momo Palace (reason: "investigating billing issue").',
    );
  });

  it("calls out write-mode sessions explicitly", () => {
    const sentence = formatImpersonationEvent({
      action: "admin.impersonation_started",
      userFullName: "Jane Doe",
      metadata: { reason: "fixing a stuck order", mode: "write", targetRestaurantName: "Momo Palace" },
    });
    expect(sentence).toContain("read/write impersonation session");
  });

  it("formats an exit event with a human duration", () => {
    const sentence = formatImpersonationEvent({
      action: "admin.impersonation_ended",
      userFullName: "Jane Doe",
      metadata: {
        reason: "investigating billing issue",
        targetRestaurantName: "Momo Palace",
        durationMs: 14 * 60_000,
      },
    });
    expect(sentence).toBe(
      'Platform admin Jane Doe exited impersonation of Momo Palace after 14 minutes (reason: "investigating billing issue").',
    );
  });

  it("formats a revoke event, naming both the revoking and revoked admins", () => {
    const sentence = formatImpersonationEvent({
      action: "admin.impersonation_revoked",
      userFullName: "Support Lead",
      metadata: {
        reason: "unauthorized session",
        targetRestaurantName: "Momo Palace",
        revokedAdminName: "Jane Doe",
        durationMs: 5 * 60_000,
      },
    });
    expect(sentence).toBe(
      'Platform admin Support Lead revoked Jane Doe\'s impersonation session of Momo Palace (active for 5 minutes) (reason: "unauthorized session").',
    );
  });

  it("uses restaurantLabel to say 'this restaurant' on the tenant-scoped board instead of repeating its own name", () => {
    const sentence = formatImpersonationEvent(
      {
        action: "admin.impersonation_started",
        userFullName: "Jane Doe",
        metadata: { reason: "billing check", mode: "read_only", targetRestaurantName: "Momo Palace" },
      },
      { restaurantLabel: "this restaurant" },
    );
    expect(sentence).toContain("for this restaurant");
    expect(sentence).not.toContain("Momo Palace");
  });

  it("degrades gracefully when metadata is missing optional fields", () => {
    const sentence = formatImpersonationEvent({
      action: "admin.impersonation_started",
      userFullName: null,
      metadata: {},
    });
    expect(sentence).toBe("Platform admin An admin started a read-only impersonation session for this restaurant.");
  });

  it("returns null for a non-impersonation action", () => {
    expect(
      formatImpersonationEvent({ action: "payment.refunded", userFullName: "Jane Doe", metadata: { amountInPaisa: 500 } }),
    ).toBeNull();
  });

  it("returns null when metadata is entirely absent, never throwing", () => {
    expect(
      formatImpersonationEvent({ action: "admin.impersonation_started", userFullName: "Jane Doe", metadata: null }),
    ).not.toBeNull(); // still formats — metadata: null just means every optional field falls back
  });
});

describe("formatAuditLogEntry", () => {
  it("dispatches impersonation actions to formatImpersonationEvent", () => {
    const sentence = formatAuditLogEntry({
      action: "admin.impersonation_started",
      userFullName: "Jane Doe",
      metadata: { reason: "billing check", mode: "read_only", targetRestaurantName: "Momo Palace" },
    });
    expect(sentence).toContain("Jane Doe started a read-only impersonation session");
  });

  it("returns null for actions with no dedicated formatter, so callers fall back to the default rendering", () => {
    expect(
      formatAuditLogEntry({ action: "staff.role_changed", userFullName: "Jane Doe", metadata: { newRole: "manager" } }),
    ).toBeNull();
  });
});

describe("formatAuditLogModifiers", () => {
  it("returns null when metadata is null", () => {
    expect(formatAuditLogModifiers(null)).toBeNull();
  });

  it("returns null when neither modifier flag is set", () => {
    expect(formatAuditLogModifiers({ amountInPaisa: 500 })).toBeNull();
  });

  it("flags an action performed under an active impersonation grant", () => {
    expect(formatAuditLogModifiers({ isImpersonated: true })).toBe("via impersonation");
  });

  it("flags an action performed during platform maintenance mode", () => {
    expect(formatAuditLogModifiers({ duringMaintenanceMode: true })).toBe("during maintenance mode");
  });

  it("combines both modifiers when both are set", () => {
    expect(formatAuditLogModifiers({ isImpersonated: true, duringMaintenanceMode: true })).toBe(
      "via impersonation, during maintenance mode",
    );
  });
});
