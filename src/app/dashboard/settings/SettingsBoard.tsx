"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { apiGet, apiPatch, ApiError } from "@/lib/api-client";
import { fileToCompressedDataUrl, ClientImageError } from "@/lib/client-image";

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

type ProfileResponse = {
  name: string;
  logoUrl: string | null;
  phone: string;
  address: string;
  city: string;
  district: string;
};

/**
 * The dashboard's Settings page — was a permanent "Coming soon" nav item
 * (see DashboardShell.tsx) until now. Three sections, each backed by its
 * own route: restaurant profile (new — /profile, the general endpoint
 * kot-settings.ts and tax-settings.ts's own comments said didn't exist
 * yet), tax details (existing /tax-settings, same route FiscalSettingsPanel
 * on the Orders page uses), and the kitchen ticket header (existing
 * /kot-settings, same route KotSettingsPanel on the KDS page uses) — this
 * page is a second, always-open surface for those two, not a replacement
 * for the popovers already living there.
 *
 * Deliberately does NOT include timezone, currency, default locale, or
 * opening hours — those either have no editor anywhere yet (opening hours)
 * or changing them after a restaurant has live orders/reports carries
 * enough downstream risk (currency, timezone) to be its own reviewed piece
 * of work rather than folded in here. See SEO/product backlog notes for
 * follow-up.
 */
export function SettingsBoard({ slug }: { slug: string }) {
  return (
    <div className="space-y-6">
      <ProfileSection slug={slug} />
      <TaxSection slug={slug} />
      <KotHeaderSection slug={slug} />
      <MoreSettingsLinks />
    </div>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
      {description && <p className="mt-1 text-xs text-neutral-500">{description}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

function ProfileSection({ slug }: { slug: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");

  const [logoProcessing, setLogoProcessing] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<ProfileResponse>(`${base(slug)}/profile`)
      .then((res) => {
        if (cancelled) return;
        setName(res.name);
        setLogoUrl(res.logoUrl ?? "");
        setPhone(res.phone);
        setAddress(res.address);
        setCity(res.city);
        setDistrict(res.district);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "Could not load restaurant profile.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function handleLogoChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLogoError(null);
    setLogoProcessing(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      setLogoUrl(dataUrl);
      setSaved(false);
    } catch (err) {
      setLogoError(err instanceof ClientImageError ? err.message : "Could not process this image.");
    } finally {
      setLogoProcessing(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await apiPatch<ProfileResponse>(`${base(slug)}/profile`, {
        name: name.trim(),
        phone: phone.trim(),
        address: address.trim(),
        city: city.trim(),
        district: district.trim(),
        logoUrl,
      });
      setName(updated.name);
      setLogoUrl(updated.logoUrl ?? "");
      setPhone(updated.phone);
      setAddress(updated.address);
      setCity(updated.city);
      setDistrict(updated.district);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <SectionCard title="Restaurant profile">
        <p className="text-xs text-neutral-400">Loading…</p>
      </SectionCard>
    );
  }

  if (loadError) {
    return (
      <SectionCard title="Restaurant profile">
        <p className="text-xs text-red-700">{loadError}</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Restaurant profile"
      description="Name, logo, and contact details — used across the dashboard, receipts, and your public website."
    >
      <form onSubmit={save} className="space-y-3">
        <div className="flex items-center gap-3">
          {logoUrl ? (
            // A client-compressed data: URL or an http(s) URL, not a static build asset.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              className="h-14 w-14 shrink-0 rounded-full border border-neutral-200 object-cover"
            />
          ) : (
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-dashed border-neutral-300 text-[10px] font-medium text-neutral-400">
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
                {logoProcessing ? "Processing…" : logoUrl ? "Replace logo" : "Upload logo"}
              </button>
              {logoUrl && (
                <button
                  type="button"
                  onClick={() => {
                    setLogoUrl("");
                    setSaved(false);
                  }}
                  className="text-xs font-medium text-neutral-400 hover:text-red-600"
                >
                  Remove
                </button>
              )}
            </div>
            {logoError && <p className="text-[11px] text-red-600">{logoError}</p>}
          </div>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Restaurant name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
            maxLength={200}
            required
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Phone</span>
          <input
            className="input"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setSaved(false);
            }}
            placeholder="98XXXXXXXX"
            required
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-700">Address</span>
          <input
            className="input"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setSaved(false);
            }}
            maxLength={500}
            required
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-700">City</span>
            <input
              className="input"
              value={city}
              onChange={(e) => {
                setCity(e.target.value);
                setSaved(false);
              }}
              maxLength={100}
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-700">District</span>
            <input
              className="input"
              value={district}
              onChange={(e) => {
                setDistrict(e.target.value);
                setSaved(false);
              }}
              maxLength={100}
              required
            />
          </label>
        </div>

        {error && <p className="text-xs text-red-700">{error}</p>}
        {saved && !error && <p className="text-xs text-green-700">Saved.</p>}

        <button type="submit" disabled={saving} className="btn-primary text-sm disabled:opacity-50">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </form>
    </SectionCard>
  );
}

function TaxSection({ slug }: { slug: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [panNumber, setPanNumber] = useState("");
  const [vatNumber, setVatNumber] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<{ panNumber: string | null; vatNumber: string | null }>(`${base(slug)}/tax-settings`)
      .then((res) => {
        if (cancelled) return;
        setPanNumber(res.panNumber ?? "");
        setVatNumber(res.vatNumber ?? "");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load tax settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await apiPatch(`${base(slug)}/tax-settings`, {
        panNumber: panNumber.trim(),
        vatNumber: vatNumber.trim(),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save tax settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Tax details"
      description="PAN and VAT registration numbers, printed on customer-facing bills once set."
    >
      {loading ? (
        <p className="text-xs text-neutral-400">Loading…</p>
      ) : (
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-700">PAN number</span>
            <input
              className="input"
              value={panNumber}
              onChange={(e) => {
                setPanNumber(e.target.value);
                setSaved(false);
              }}
              maxLength={20}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-700">VAT number (if registered)</span>
            <input
              className="input"
              value={vatNumber}
              onChange={(e) => {
                setVatNumber(e.target.value);
                setSaved(false);
              }}
              maxLength={20}
            />
          </label>
          <p className="text-[11px] text-neutral-400">
            Leave a field blank to omit that line on bills — most restaurants below the
            VAT-registration threshold set only PAN.
          </p>
          {error && <p className="text-xs text-red-700">{error}</p>}
          {saved && !error && <p className="text-xs text-green-700">Saved.</p>}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="btn-secondary text-sm disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </SectionCard>
  );
}

function KotHeaderSection({ slug }: { slug: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [restaurantName, setRestaurantName] = useState("");
  const [headerText, setHeaderText] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<{ restaurantName: string; kotHeaderText: string | null }>(`${base(slug)}/kot-settings`)
      .then((res) => {
        if (cancelled) return;
        setRestaurantName(res.restaurantName);
        setHeaderText(res.kotHeaderText ?? "");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load ticket settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await apiPatch(`${base(slug)}/kot-settings`, { kotHeaderText: headerText.trim() });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save ticket settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Kitchen ticket header"
      description="What prints at the top of every Kitchen Order Ticket."
    >
      {loading ? (
        <p className="text-xs text-neutral-400">Loading…</p>
      ) : (
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-700">Ticket header text</span>
            <input
              className="input"
              placeholder={restaurantName || "Restaurant name"}
              value={headerText}
              onChange={(e) => {
                setHeaderText(e.target.value);
                setSaved(false);
              }}
              maxLength={200}
            />
          </label>
          <p className="text-[11px] text-neutral-400">
            Leave blank to use the restaurant name ({restaurantName}).
          </p>
          {error && <p className="text-xs text-red-700">{error}</p>}
          {saved && !error && <p className="text-xs text-green-700">Saved.</p>}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="btn-secondary text-sm disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </SectionCard>
  );
}

function MoreSettingsLinks() {
  const links: { href: string; label: string; description: string }[] = [
    {
      href: "/dashboard/website",
      label: "Website",
      description: "Public page content, gallery, and QR code",
    },
    {
      href: "/dashboard/inventory",
      label: "Inventory alerts",
      description: "Low-stock thresholds and enforcement",
    },
    {
      href: "/dashboard/staff",
      label: "Staff attendance & holidays",
      description: "Clock-in rules, selfie verification, closed days",
    },
    {
      href: "/dashboard/branches",
      label: "Branches",
      description: "Add and manage physical locations",
    },
  ];

  return (
    <SectionCard title="More settings" description="Settings that live with the feature they configure.">
      <ul className="divide-y divide-neutral-100">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="flex items-center justify-between gap-4 py-2.5 text-sm text-neutral-700 hover:text-neutral-900"
            >
              <span>
                <span className="font-medium">{link.label}</span>
                <span className="ml-2 text-xs text-neutral-400">{link.description}</span>
              </span>
              <span aria-hidden className="text-neutral-300">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
