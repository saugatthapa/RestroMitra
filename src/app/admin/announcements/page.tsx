import { AnnouncementsBoard } from "./AnnouncementsBoard";

export default function AnnouncementsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Announcements</h1>
        <p className="text-sm text-ink-muted">
          Shown as a banner on every restaurant&apos;s dashboard while active. Use for scheduled
          maintenance notices, new-feature callouts, or anything every tenant should see.
        </p>
      </div>
      <AnnouncementsBoard />
    </div>
  );
}
