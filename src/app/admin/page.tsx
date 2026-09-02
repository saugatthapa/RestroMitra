import { AdminOverview } from "./AdminOverview";
import { ActiveImpersonationSessions } from "./ActiveImpersonationSessions";
import { DashboardMetrics } from "./DashboardMetrics";
import { AlertsPanel } from "./AlertsPanel";
import { AtRiskTenants } from "./AtRiskTenants";

export default function AdminHomePage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Dashboard</h1>
        <p className="text-sm text-neutral-500">Platform-wide metrics and every restaurant on the platform.</p>
      </div>
      <DashboardMetrics />
      <AlertsPanel />
      <AtRiskTenants />
      <ActiveImpersonationSessions />
      <AdminOverview />
    </div>
  );
}
