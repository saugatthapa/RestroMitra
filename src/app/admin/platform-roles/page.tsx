import { PlatformRolesBoard } from "./PlatformRolesBoard";

export default function PlatformRolesPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Platform admins</h1>
        <p className="text-sm text-ink-muted">
          Grant or revoke platform-level access. Every change here is written to the platform
          audit log with the reason given.
        </p>
      </div>
      <PlatformRolesBoard />
    </div>
  );
}
