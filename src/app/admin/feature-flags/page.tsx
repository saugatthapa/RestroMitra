import { FeatureFlagsBoard } from "./FeatureFlagsBoard";

export default function FeatureFlagsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Feature flags</h1>
        <p className="text-sm text-neutral-500">
          Global defaults for capabilities not (only) governed by a plan. Per-tenant exceptions
          live on each restaurant&apos;s own page, under Entitlements.
        </p>
      </div>
      <FeatureFlagsBoard />
    </div>
  );
}
