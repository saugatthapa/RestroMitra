import { AdminOverview } from "./AdminOverview";

export default function AdminHomePage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Restaurants</h1>
        <p className="text-sm text-neutral-500">Every restaurant on the platform.</p>
      </div>
      <AdminOverview />
    </div>
  );
}
