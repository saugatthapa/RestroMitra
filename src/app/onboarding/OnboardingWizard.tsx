"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { apiPost, ApiError } from "@/lib/api-client";
import { restaurantTypes } from "@/lib/validation/onboarding";
import { fileToCompressedDataUrl, ClientImageError } from "@/lib/client-image";

const TYPE_LABELS: Record<(typeof restaurantTypes)[number], string> = {
  cafe: "Cafe",
  restaurant: "Restaurant",
  fast_food: "Fast food",
  momo_shop: "Momo shop",
  bar: "Bar",
  hotel_restaurant: "Hotel restaurant",
  bakery: "Bakery",
  other: "Other",
};

type FormState = {
  name: string;
  type: (typeof restaurantTypes)[number];
  address: string;
  city: string;
  district: string;
  phone: string;
  panVat: string;
  openTime: string;
  closeTime: string;
  logoUrl: string;
};

const STEPS = [
  "Restaurant name",
  "Type",
  "Address & phone",
  "PAN/VAT",
  "Opening hours",
  "Review",
] as const;

export function OnboardingWizard({ ownerName }: { ownerName: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [form, setForm] = useState<FormState>({
    name: "",
    type: "restaurant",
    address: "",
    city: "Itahari",
    district: "Sunsari",
    phone: "",
    panVat: "",
    openTime: "08:00",
    closeTime: "21:00",
    logoUrl: "",
  });
  const [logoProcessing, setLogoProcessing] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleLogoChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLogoError(null);
    setLogoProcessing(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      update("logoUrl", dataUrl);
    } catch (err) {
      setLogoError(err instanceof ClientImageError ? err.message : "Could not process that image.");
    } finally {
      setLogoProcessing(false);
    }
  }

  function canAdvance(): boolean {
    switch (step) {
      case 0:
        return form.name.trim().length >= 2;
      case 1:
        return Boolean(form.type);
      case 2:
        return (
          form.address.trim().length >= 2 &&
          form.city.trim().length >= 1 &&
          form.district.trim().length >= 1 &&
          /^9[678]\d{8}$/.test(form.phone.trim())
        );
      case 3:
        return true; // optional
      case 4:
        return Boolean(form.openTime && form.closeTime);
      default:
        return true;
    }
  }

  async function handleCreate() {
    setError(null);
    setSubmitting(true);
    try {
      await apiPost("/api/onboarding/restaurant", form);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create restaurant.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-hairline bg-surface-2 p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-ink">
          {form.name} is set up 🎉
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Your 30-day free trial has started. Here&apos;s what&apos;s ready now, and
          what&apos;s coming as we build out the rest of the platform.
        </p>

        <ul className="mt-5 space-y-2 text-sm">
          <ProgressItem done label="Restaurant profile & main branch created" />
          <ProgressItem done label={`Owner account (${ownerName}) linked`} />
          <ProgressItem label="Menu &amp; categories — next phase" />
          <ProgressItem label="Tables & QR codes — next phase" />
          <ProgressItem label="Staff invites — coming soon" />
        </ul>

        <button
          onClick={() => {
            router.push("/dashboard");
            router.refresh();
          }}
          className="btn-primary mt-6 w-full"
        >
          Go to dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-6 shadow-sm">
      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between text-xs font-medium text-ink-muted">
          <span>
            Step {step + 1} of {STEPS.length}
          </span>
          <span>{STEPS[step]}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-1">
          <div
            className="h-full rounded-full bg-orange-600 transition-all"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      </div>

      {step === 0 && (
        <StepBlock title="What's your restaurant called?">
          <input
            autoFocus
            className="input"
            placeholder="e.g. Momo House Itahari"
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
          />

          <div className="mt-4">
            <span className="mb-1.5 block text-xs font-medium text-ink-muted">
              Logo (optional)
            </span>
            <div className="flex items-center gap-3">
              {form.logoUrl ? (
                // A client-compressed data: URL, not a static build asset.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={form.logoUrl}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-full border border-hairline object-cover"
                />
              ) : (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-dashed border-hairline-strong text-[10px] font-medium text-ink-faint">
                  No logo
                </span>
              )}
              <div className="flex flex-col gap-1.5">
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleLogoChosen}
                  className="hidden"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => logoInputRef.current?.click()}
                    disabled={logoProcessing}
                    className="btn-secondary text-xs disabled:opacity-50"
                  >
                    {logoProcessing ? "Processing…" : form.logoUrl ? "Replace logo" : "Upload logo"}
                  </button>
                  {form.logoUrl && (
                    <button
                      type="button"
                      onClick={() => update("logoUrl", "")}
                      className="text-xs font-medium text-ink-faint hover:text-red-400"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-ink-faint">
                  Shown in your dashboard sidebar. You can skip this and add it later.
                </p>
              </div>
            </div>
            {logoError && <p className="mt-1 text-xs text-red-400">{logoError}</p>}
          </div>
        </StepBlock>
      )}

      {step === 1 && (
        <StepBlock title="What type of business is it?">
          <div className="grid grid-cols-2 gap-2">
            {restaurantTypes.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => update("type", t)}
                className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                  form.type === t
                    ? "border-orange-600 bg-orange-500/15 text-orange-400"
                    : "border-hairline-strong text-ink-secondary hover:bg-surface-1"
                }`}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </StepBlock>
      )}

      {step === 2 && (
        <StepBlock title="Where is it, and how can customers reach you?">
          <div className="space-y-3">
            <input
              className="input"
              placeholder="Street address"
              value={form.address}
              onChange={(e) => update("address", e.target.value)}
            />
            <div className="grid grid-cols-2 gap-3">
              <input
                className="input"
                placeholder="City (e.g. Itahari)"
                value={form.city}
                onChange={(e) => update("city", e.target.value)}
              />
              <input
                className="input"
                placeholder="District (e.g. Sunsari)"
                value={form.district}
                onChange={(e) => update("district", e.target.value)}
              />
            </div>
            <input
              className="input"
              placeholder="Restaurant phone (98XXXXXXXX)"
              inputMode="numeric"
              value={form.phone}
              onChange={(e) => update("phone", e.target.value)}
            />
          </div>
        </StepBlock>
      )}

      {step === 3 && (
        <StepBlock title="PAN/VAT number (optional)">
          <input
            className="input"
            placeholder="e.g. 123456789"
            value={form.panVat}
            onChange={(e) => update("panVat", e.target.value)}
          />
          <p className="mt-2 text-xs text-ink-muted">
            You can add this later from Settings. Before commercial launch, tax/invoice
            configuration should be confirmed against current IRD requirements.
          </p>
        </StepBlock>
      )}

      {step === 4 && (
        <StepBlock title="Opening hours">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-secondary">Opens</span>
              <input
                type="time"
                className="input"
                value={form.openTime}
                onChange={(e) => update("openTime", e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-secondary">Closes</span>
              <input
                type="time"
                className="input"
                value={form.closeTime}
                onChange={(e) => update("closeTime", e.target.value)}
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            Applied to all days for now — per-day hours can be customized later in Settings.
          </p>
        </StepBlock>
      )}

      {step === 5 && (
        <StepBlock title="Review & create">
          <dl className="divide-y divide-hairline/60 rounded-lg border border-hairline text-sm">
            <ReviewRow label="Name" value={form.name} />
            <ReviewRow label="Type" value={TYPE_LABELS[form.type]} />
            <ReviewRow label="Address" value={`${form.address}, ${form.city}, ${form.district}`} />
            <ReviewRow label="Phone" value={form.phone} />
            <ReviewRow label="PAN/VAT" value={form.panVat || "—"} />
            <ReviewRow label="Hours" value={`${form.openTime} – ${form.closeTime}`} />
            <div className="flex items-center justify-between gap-4 px-3 py-2">
              <dt className="text-ink-muted">Logo</dt>
              <dd>
                {form.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- see note above
                  <img
                    src={form.logoUrl}
                    alt=""
                    className="h-7 w-7 rounded-full border border-hairline object-cover"
                  />
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </dd>
            </div>
          </dl>
        </StepBlock>
      )}

      {error && (
        <p className="mt-4 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      <div className="mt-6 flex gap-3">
        {step > 0 && (
          <button
            type="button"
            className="btn-secondary flex-1"
            onClick={() => setStep((s) => s - 1)}
            disabled={submitting}
          >
            Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={!canAdvance()}
            onClick={() => setStep((s) => s + 1)}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={submitting}
            onClick={handleCreate}
          >
            {submitting ? "Creating…" : "Create restaurant"}
          </button>
        )}
      </div>
    </div>
  );
}

function StepBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-3 text-base font-semibold text-ink">{title}</h2>
      {children}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{value}</dd>
    </div>
  );
}

function ProgressItem({ label, done }: { label: string; done?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${
          done ? "bg-green-600 text-white" : "bg-surface-3 text-ink-muted"
        }`}
      >
        {done ? "✓" : "•"}
      </span>
      <span className={done ? "text-ink" : "text-ink-muted"}>{label}</span>
    </li>
  );
}
