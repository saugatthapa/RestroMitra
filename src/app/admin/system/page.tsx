import { SystemHealthPanel } from "./SystemHealthPanel";
import { VerificationContactPanel } from "./VerificationContactPanel";

export default function SystemPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">System</h1>
        <p className="text-sm text-neutral-500">
          Operational health and platform-wide maintenance mode. Enabling maintenance mode blocks
          every tenant&apos;s dashboard and API access except platform admins — the emergency
          access this is meant to preserve.
        </p>
      </div>
      <SystemHealthPanel />
      <div className="mt-6">
        <VerificationContactPanel />
      </div>
    </div>
  );
}
