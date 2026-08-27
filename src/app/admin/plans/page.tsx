import { PlansBoard } from "./PlansBoard";

export default function PlansPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">Plans</h1>
        <p className="text-sm text-neutral-500">
          The catalog restaurants sign up under and platform admins assign — pricing, seat/branch
          limits, and which features each plan entitles.
        </p>
      </div>
      <PlansBoard />
    </div>
  );
}
