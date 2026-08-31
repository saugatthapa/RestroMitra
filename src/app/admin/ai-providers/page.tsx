import { AiProvidersBoard } from "./AiProvidersBoard";

export default function AiProvidersPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">AI providers</h1>
        <p className="text-sm text-neutral-500">
          Configure encrypted provider credentials for the AI assistant. When any provider below
          is enabled, it replaces the env-var-based configuration entirely — the assistant tries
          enabled providers in priority order (lowest first) and fails over automatically.
        </p>
      </div>
      <AiProvidersBoard />
    </div>
  );
}
