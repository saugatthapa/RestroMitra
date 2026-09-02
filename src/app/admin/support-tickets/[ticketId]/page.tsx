import { AdminTicketThread } from "./AdminTicketThread";

export default async function AdminSupportTicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = await params;
  return <AdminTicketThread ticketId={ticketId} />;
}
