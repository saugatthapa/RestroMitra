import { AdminSupportTicketsBoard } from "./AdminSupportTicketsBoard";

export default function AdminSupportTicketsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Support tickets</h1>
        <p className="text-sm text-neutral-500">
          Issues filed by tenants from their own dashboard — reply, and update status as you work
          each one.
        </p>
      </div>
      <AdminSupportTicketsBoard />
    </div>
  );
}
