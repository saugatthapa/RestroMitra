import { PlatformRolesBoard } from "./PlatformRolesBoard";

export default function PlatformRolesPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Platform admins</h1>
        <p className="text-sm text-neutral-500">
          Grant or revoke platform-level access. Every change here is written to the platform
          audit log with the reason given.
        </p>
      </div>
      <PlatformRolesBoard />
    </div>
  );
}
