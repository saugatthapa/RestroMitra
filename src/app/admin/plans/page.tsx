import { PlansBoard } from "./PlansBoard";

export default function PlansPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Plans</h1>
        <p className="text-sm text-ink-muted">
          The catalog restaurants sign up under and platform admins assign — pricing, seat/branch
          limits, and which features each plan entitles.
        </p>
      </div>
      <PlansBoard />
    </div>
  );
}
