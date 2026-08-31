import { AdminOverview } from "./AdminOverview";
import { ActiveImpersonationSessions } from "./ActiveImpersonationSessions";

export default function AdminHomePage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Restaurants</h1>
        <p className="text-sm text-neutral-500">Every restaurant on the platform.</p>
      </div>
      <ActiveImpersonationSessions />
      <AdminOverview />
    </div>
  );
}
