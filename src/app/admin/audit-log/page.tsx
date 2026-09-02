import { AuditLogBoard } from "./AuditLogBoard";

export default function PlatformAuditLogPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Platform audit log</h1>
        <p className="text-sm text-ink-muted">
          Every recorded action across every tenant, plus platform-level events (role grants,
          plan and feature flag changes, entitlement overrides) with no single tenant.
        </p>
      </div>
      <AuditLogBoard />
    </div>
  );
}
