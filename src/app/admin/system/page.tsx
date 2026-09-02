import { SystemHealthPanel } from "./SystemHealthPanel";

export default function SystemPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">System</h1>
        <p className="text-sm text-ink-muted">
          Operational health and platform-wide maintenance mode. Enabling maintenance mode blocks
          every tenant&apos;s dashboard and API access except platform admins — the emergency
          access this is meant to preserve.
        </p>
      </div>
      <SystemHealthPanel />
    </div>
  );
}
